import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { Queue } from "bullmq";
import { PublicKey } from "@solana/web3.js";
import { PROGRAM_IDS, QUEUES, TokenInfoClient, binsForRange, type Config, type OpenJob } from "@binflip/core";
import { schema, type Db } from "@binflip/db";
import { MeteoraData, num, poolRow } from "./meteora.js";

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const base58 = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
/** Rent of one DLMM bin array account (70 bins, 10136 bytes). Paid once by whoever opens it; not refunded. */
const BIN_ARRAY_RENT_SOL = 0.07143744;
/** Rent of a DLMM position (refunded on close); wider positions cost a little more per extra bin. */
const positionRent = (bins: number) => 0.0573 + Math.max(0, bins - 70) * 0.000668;

/**
 * LP Agent "Pools" + pool page + "Create a Position" (Meteora DLMM and DAMM V2).
 * Lists and stats come from Meteora's data API; opening a position is queued
 * for the executor (agent wallet), never signed here.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerPools(app: FastifyInstance<any, any, any, any>, db: Db, config: Config, meteora: MeteoraData) {
  const tokens = new TokenInfoClient();
  const openQueue = new Queue<OpenJob>(QUEUES.OPEN, { connection: { url: config.REDIS_URL } as never });

  const ListQuery = z.object({
    protocol: z.enum(["dlmm", "damm_v2"]).default("dlmm"),
    window: z.enum(["30m", "1h", "2h", "4h", "12h", "24h"]).default("24h"),
    sort: z.enum(["fee_tvl", "tvl", "volume"]).default("fee_tvl"),
    dir: z.enum(["asc", "desc"]).default("desc"),
    page: z.coerce.number().int().min(1).max(500).default(1),
    pageSize: z.coerce.number().int().min(5).max(100).default(20),
    quote: z.enum(["sol", "usdc", "sol_usdc", "all"]).default("sol"),
    q: z.string().max(64).optional(),
    minTvl: z.coerce.number().optional(),
    maxTvl: z.coerce.number().optional(),
    minVolume: z.coerce.number().optional(),
    minVolume1h: z.coerce.number().optional(),
    minFeeTvl: z.coerce.number().optional(),
    binStep: z.coerce.number().int().optional(),
    minMcap: z.coerce.number().optional(),
    maxMcap: z.coerce.number().optional(),
    minHolders: z.coerce.number().optional(),
    minFees: z.coerce.number().optional(),
    minAgeH: z.coerce.number().optional(),
    maxAgeH: z.coerce.number().optional(),
    minBaseFee: z.coerce.number().optional(),
    maxBaseFee: z.coerce.number().optional(),
  });

  app.get("/v1/pools", async (req, reply) => {
    const q = ListQuery.parse(req.query);
    const f: string[] = [];
    if (q.minTvl !== undefined) f.push(`tvl>${q.minTvl}`);
    if (q.maxTvl !== undefined) f.push(`tvl<${q.maxTvl}`);
    if (q.minVolume !== undefined) f.push(`volume_${q.window}>${q.minVolume}`);
    if (q.minVolume1h !== undefined) f.push(`volume_1h>${q.minVolume1h}`);
    if (q.minFeeTvl !== undefined) f.push(`fee_tvl_ratio_${q.window}>${q.minFeeTvl}`);
    if (q.binStep !== undefined && q.protocol === "dlmm") f.push(`bin_step=${q.binStep}`);
    if (q.quote === "sol") f.push(`token_y=${SOL}`);
    if (q.quote === "usdc") f.push(`token_y=${USDC}`);
    const sortField = q.sort === "fee_tvl" ? `fee_tvl_ratio_${q.window}` : q.sort === "volume" ? `volume_${q.window}` : "tvl";
    // Fields the API can't filter on (mcap, holders, fees, age, base fee) are applied to the page here.
    const post = [q.minMcap, q.maxMcap, q.minHolders, q.minFees, q.minAgeH, q.maxAgeH, q.minBaseFee, q.maxBaseFee].some((v) => v !== undefined);
    try {
      const res = await meteora.pools({
        protocol: q.protocol,
        page: q.page,
        pageSize: post ? Math.min(100, q.pageSize * 4) : q.pageSize,
        sort: `${sortField}:${q.dir}`,
        filter: f.join(" && ") || undefined,
        query: q.q?.trim() || undefined,
      });
      const now = Date.now();
      let rows = res.data.map((p) => poolRow(p, q.window));
      rows = rows.filter((r) => {
        const ageH = r.createdAt ? (now - new Date(r.createdAt).getTime()) / 3_600_000 : null;
        return (
          (q.minMcap === undefined || r.base.mcap >= q.minMcap) &&
          (q.maxMcap === undefined || r.base.mcap <= q.maxMcap) &&
          (q.minHolders === undefined || r.base.holders >= q.minHolders) &&
          (q.minFees === undefined || r.fees >= q.minFees) &&
          (q.minAgeH === undefined || (ageH !== null && ageH >= q.minAgeH)) &&
          (q.maxAgeH === undefined || (ageH !== null && ageH <= q.maxAgeH)) &&
          (q.minBaseFee === undefined || r.baseFeePct >= q.minBaseFee) &&
          (q.maxBaseFee === undefined || r.baseFeePct <= q.maxBaseFee)
        );
      });
      return { total: res.total, pages: res.pages, page: q.page, rows: rows.slice(0, q.pageSize), filtered: post, updatedAt: new Date().toISOString() };
    } catch (err) {
      return reply.code(502).send({ error: `Meteora verisi alınamadı: ${(err as Error).message}` });
    }
  });

  // ── Search anything: a pasted address is a pool, a token or a wallet ──
  app.get("/v1/resolve/:address", async (req) => {
    const { address } = z.object({ address: base58 }).parse(req.params);
    for (const protocol of ["dlmm", "damm_v2"] as const) {
      const pool = await meteora.pool(address, protocol).catch(() => null);
      if (pool?.address) return { type: "pool", protocol, href: `/pools/${address}?protocol=${protocol}` };
    }
    const t = await tokens.get(address).catch(() => null);
    if (t?.symbol) return { type: "token", symbol: t.symbol, href: `/pools?q=${address}` };
    return { type: "wallet", href: `/wallet/${address}` };
  });

  // ── Pool page ──────────────────────────────────────────────────────────
  app.get("/v1/pools/:address", async (req, reply) => {
    const { address } = z.object({ address: base58 }).parse(req.params);
    const { protocol } = z.object({ protocol: z.enum(["dlmm", "damm_v2"]).default("dlmm") }).parse(req.query);
    let raw: Record<string, any>;
    try {
      raw = await meteora.pool(address, protocol);
    } catch (err) {
      return reply.code(404).send({ error: `havuz bulunamadı: ${(err as Error).message}` });
    }
    const row = poolRow(raw, "24h");
    const info = await tokens.get(row.base.mint).catch(() => null);
    const mine = await db
      .select()
      .from(schema.positions)
      .where(and(eq(schema.positions.userId, req.userId!), eq(schema.positions.pool, address)))
      .orderBy(desc(schema.positions.createdAt))
      .limit(100);
    const others = await db.select({ id: schema.positions.id }).from(schema.positions).where(eq(schema.positions.pool, address)).limit(1);
    return {
      protocol,
      pool: row,
      reserves: { x: num(raw.token_x_amount), y: num(raw.token_y_amount) },
      fees24h: num(raw.fees?.["24h"]),
      volume24h: num(raw.volume?.["24h"]),
      feeTvl: raw.fee_tvl_ratio ?? {},
      volume: raw.volume ?? {},
      fees: raw.fees ?? {},
      dynamicFeePct: num(raw.dynamic_fee_pct),
      maxFeePct: num(raw.pool_config?.max_fee_pct),
      token: info
        ? { symbol: info.symbol, name: info.name ?? null, icon: info.icon ?? null, organicScore: info.organicScore, mcapUsd: info.mcapUsd, holders: info.holders, volume24hUsd: info.volume24hUsd, createdAt: info.createdAt }
        : null,
      mine: mine.map((p) => ({
        id: p.id,
        state: p.state,
        dryRun: p.dryRun,
        source: p.leaderId ? "auto" : "manual",
        origin: p.origin,
        strategy: p.strategy,
        invested: Number(p.depositedSol) / 1e9,
        value: p.currentValueSol === null ? null : Number(p.currentValueSol),
        lower: p.lowerBinId,
        upper: p.upperBinId,
        openedAt: p.openedAt ?? p.createdAt,
        closedAt: p.closedAt,
      })),
      known: others.length > 0,
      links: {
        meteora: `https://app.meteora.ag/${protocol === "dlmm" ? "dlmm" : "dammv2"}/${address}`,
        dexscreener: `https://dexscreener.com/solana/${address}`,
        gmgn: `https://gmgn.ai/sol/token/${row.base.mint}`,
        solscan: `https://solscan.io/account/${address}`,
        bubblemaps: `https://app.bubblemaps.io/sol/token/${row.base.mint}`,
      },
    };
  });

  // ── Candles: Meteora (5m..24h) or GeckoTerminal (1m, 15m) ──────────────
  app.get("/v1/pools/:address/candles", async (req, reply) => {
    const { address } = z.object({ address: base58 }).parse(req.params);
    const { tf, protocol } = z.object({ tf: z.enum(["1m", "5m", "15m", "30m", "1h", "4h", "12h", "24h"]).default("5m"), protocol: z.enum(["dlmm", "damm_v2"]).default("dlmm") }).parse(req.query);
    try {
      // GeckoTerminal has deep history for every timeframe; Meteora's own candles (10 bars) are the fallback.
      const g: Record<string, [string, number]> = { "1m": ["minute", 1], "5m": ["minute", 5], "15m": ["minute", 15], "30m": ["minute", 15], "1h": ["hour", 1], "4h": ["hour", 4], "12h": ["hour", 12], "24h": ["day", 1] };
      const [unit, agg] = g[tf]!;
      const gres = await fetch(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${address}/ohlcv/${unit}?aggregate=${agg}&limit=300&currency=token`, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
      if (gres?.ok) {
        const body = (await gres.json()) as { data?: { attributes?: { ohlcv_list?: number[][] } } };
        const list = (body.data?.attributes?.ohlcv_list ?? []).map(([t, o, h, l, c, v]) => ({ t: t!, o: o!, h: h!, l: l!, c: c!, v: v! })).sort((a, b) => a.t - b.t);
        if (list.length) return { tf, source: "geckoterminal", candles: list };
      }
      const res = await meteora.ohlcv(address, tf === "1m" || tf === "15m" ? "5m" : tf, protocol);
      return { tf, candles: res.data.map((d) => ({ t: d.timestamp, o: d.open, h: d.high, l: d.low, c: d.close, v: d.volume })) };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  // ── Cost estimate before Create Position ───────────────────────────────
  app.get("/v1/pools/:address/estimate", async (req, reply) => {
    const { address } = z.object({ address: base58 }).parse(req.params);
    const q = z.object({ lowerPct: z.coerce.number(), upperPct: z.coerce.number(), activeBin: z.coerce.number().int(), binStep: z.coerce.number().int().positive() }).parse(req.query);
    let r;
    try {
      r = binsForRange(q.activeBin, q.binStep, q.lowerPct, q.upperPct);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    // Bin arrays (70 bins each) that nobody opened yet cost a one-time, non-refundable rent.
    const first = Math.floor(r.lower / 70);
    const last = Math.floor(r.upper / 70);
    const pdas: string[] = [];
    for (let i = first; i <= last; i++) {
      const idx = Buffer.alloc(8);
      idx.writeBigInt64LE(BigInt(i));
      pdas.push(PublicKey.findProgramAddressSync([Buffer.from("bin_array"), new PublicKey(address).toBuffer(), idx], new PublicKey(PROGRAM_IDS.DLMM))[0].toBase58());
    }
    let missing: number | null = null;
    try {
      const res = await fetch(config.SOLANA_RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [pdas, { encoding: "base64", dataSlice: { offset: 0, length: 0 }, commitment: "confirmed" }] }),
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await res.json()) as { result?: { value: Array<unknown | null> } };
      missing = body.result ? body.result.value.filter((v) => v === null).length : null;
    } catch {
      missing = null;
    }
    return {
      ...r,
      binArrays: pdas.length,
      newBinArrays: missing,
      positionRentSol: positionRent(r.bins),
      newBinRentSol: missing === null ? null : missing * BIN_ARRAY_RENT_SOL,
      swapBufferSol: 0.02,
    };
  });

  // ── Create Position ────────────────────────────────────────────────────
  const OpenBody = z.object({
    protocol: z.enum(["dlmm", "damm_v2"]).default("dlmm"),
    amountSol: z.number().positive().max(10_000),
    lowerPct: z.number().gt(-100).lt(1000).default(-50),
    upperPct: z.number().gt(-100).lt(1000).default(0),
    strategy: z.enum(["spot", "curve", "bid_ask"]).default("bid_ask"),
    managementMode: z.enum(["mirror", "staged_flip", "bottom_flip", "precision_hybrid"]).default("staged_flip"),
    flipThresholdPct: z.number().min(1).max(90).optional(),
    reshapeBins: z.number().int().min(1).max(51).optional(),
    feeMode: z.enum(["compound", "sell", "hold"]).default("compound"),
    compoundMinutes: z.number().int().min(5).max(10_080).optional(),
    takeProfitPct: z.number().min(0.1).max(10_000).nullable().optional(),
    stopLossPct: z.number().min(0.1).max(100).nullable().optional(),
    trailingPct: z.number().min(0.1).max(100).nullable().optional(),
  });

  app.post("/v1/pools/:address/open", async (req, reply) => {
    const { address } = z.object({ address: base58 }).parse(req.params);
    const b = OpenBody.parse(req.body);
    if (b.lowerPct >= b.upperPct) return reply.code(400).send({ error: "alt sınır üst sınırdan küçük olmalı" });
    const job = toOpenJob(req.userId!, address, b, "panel");
    await openQueue.add("open", job, { jobId: `open_${job.requestId}`, attempts: 1, removeOnComplete: { age: 86_400 } });
    return { ok: true, requestId: job.requestId, mode: config.mode };
  });
}

export function toOpenJob(
  userId: string,
  pool: string,
  b: {
    protocol: "dlmm" | "damm_v2";
    amountSol: number;
    lowerPct: number;
    upperPct: number;
    strategy: "spot" | "curve" | "bid_ask";
    managementMode: "mirror" | "staged_flip" | "bottom_flip" | "precision_hybrid";
    flipThresholdPct?: number;
    reshapeBins?: number;
    feeMode: "compound" | "sell" | "hold";
    compoundMinutes?: number;
    takeProfitPct?: number | null;
    stopLossPct?: number | null;
    trailingPct?: number | null;
  },
  origin: "panel" | "telegram",
  chatId?: string,
): OpenJob {
  const bps = (v: number | null | undefined) => (v === null || v === undefined ? null : Math.round(v * 100));
  return {
    userId,
    requestId: randomUUID(),
    origin,
    protocol: b.protocol,
    pool,
    lamports: String(Math.round(b.amountSol * 1e9)),
    lowerPct: b.lowerPct,
    upperPct: b.upperPct,
    strategy: b.strategy,
    managementMode: b.managementMode,
    ...(b.flipThresholdPct ? { flipThresholdBps: Math.round(b.flipThresholdPct * 100) } : {}),
    ...(b.reshapeBins ? { reshapeBins: b.reshapeBins } : {}),
    feeMode: b.feeMode,
    ...(b.compoundMinutes ? { compoundMinutes: b.compoundMinutes } : {}),
    takeProfitBps: bps(b.takeProfitPct),
    stopLossBps: bps(b.stopLossPct),
    trailingStopBps: bps(b.trailingPct),
    ...(chatId ? { chatId } : {}),
  };
}
