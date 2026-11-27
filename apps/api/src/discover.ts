import type { FastifyInstance } from "fastify";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Config } from "@binflip/core";
import { schema, type Db } from "@binflip/db";
import { MeteoraData, num } from "./meteora.js";

const JUP = "https://lite-api.jup.ag/tokens/v2";
const SOL = "So11111111111111111111111111111111111111112";
type Json = Record<string, any>;

/**
 * Safety score out of 100 (LP Agent shows Safe ≥ 75, Caution 40–74, Risky < 40).
 * Built from the same checks LP Agent lists: mint and freeze authority revoked,
 * top-10 holder concentration, organic score and holder count.
 */
export function safetyScore(t: { mintAuthority?: string | null; freezeAuthority?: string | null; top10Pct?: number | null; organicScore?: number | null; holders?: number | null }): number | null {
  if (t.top10Pct === undefined && t.organicScore === undefined) return null;
  let s = 0;
  if (!t.mintAuthority) s += 25;
  if (!t.freezeAuthority) s += 25;
  const top = t.top10Pct ?? 100;
  s += top <= 15 ? 20 : top <= 30 ? 12 : top <= 50 ? 5 : 0;
  s += Math.min(20, Math.max(0, (t.organicScore ?? 0) * 0.2));
  const h = t.holders ?? 0;
  s += h >= 1000 ? 10 : h >= 100 ? 5 : 0;
  return Math.round(s);
}
/**
 * Change of Fee/TVL against the window before it, in %. Meteora's ratios are
 * fees over the window ÷ current TVL, so windows subtract: the 30 minutes before
 * the last 30 = 1h − 30m, the hour before = 2h − 1h, the 4h before ≈ (12h − 4h) / 2.
 */
export function feeTvlChange(r: Record<string, unknown>, w: "30m" | "1h" | "4h"): number | null {
  const n = (k: string) => num(r[k]);
  const [cur, prev] = w === "30m" ? [n("30m"), n("1h") - n("30m")] : w === "1h" ? [n("1h"), n("2h") - n("1h")] : [n("4h"), (n("12h") - n("4h")) / 2];
  return prev > 0 ? ((cur - prev) / prev) * 100 : null;
}

export const safetyLabel = (s: number | null) => (s === null ? null : s >= 75 ? "safe" : s >= 40 ? "caution" : "risky");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerDiscover(app: FastifyInstance<any, any, any, any>, db: Db, config: Config, meteora: MeteoraData) {
  const cache = new Map<string, { at: number; data: unknown }>();
  async function jup(path: string, ttl = 60_000): Promise<Json[]> {
    const hit = cache.get(path);
    if (hit && Date.now() - hit.at < ttl) return hit.data as Json[];
    const res = await fetch(`${JUP}${path}`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`jupiter ${res.status}`);
    const data = (await res.json()) as Json[];
    cache.set(path, { at: Date.now(), data });
    return data;
  }
  async function tokensByMint(mints: string[]): Promise<Json[]> {
    const out: Json[] = [];
    for (let i = 0; i < mints.length; i += 50) out.push(...(await jup(`/search?query=${mints.slice(i, i + 50).join(",")}`, 120_000)));
    return out;
  }

  // ── Smart LP ───────────────────────────────────────────────────────────
  const SmartQuery = z.object({
    active: z.enum(["24h", "7d", "30d", "any"]).default("7d"),
    minWinRate: z.coerce.number().min(0).max(100).default(80),
    minPositions: z.coerce.number().min(0).default(50),
    minProfit: z.coerce.number().optional(),
    minMonthly: z.coerce.number().optional(),
    minEv: z.coerce.number().optional(),
    minFees: z.coerce.number().optional(),
    sizeToWallet: z.enum(["true", "false"]).default("true"),
    sort: z.enum(["pnl_all", "pnl_7d", "pnl_30d", "win_rate", "positions", "fees", "monthly", "ev", "last_active", "invested"]).default("pnl_all"),
    dir: z.enum(["asc", "desc"]).default("desc"),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  });

  app.get("/v1/smart-lp", async (req) => {
    const q = SmartQuery.parse(req.query);
    const w = schema.smartWallets;
    // LP Agent sizes the list to you: total profit up to 5× your net worth, never less than 20 SOL.
    const open = await db.select({ v: schema.positions.currentValueSol }).from(schema.positions).where(and(eq(schema.positions.userId, req.userId!), eq(schema.positions.dryRun, false), inArray(schema.positions.state, ["ACTIVE", "OPENING", "FLIPPING", "HOLDING"])));
    const [agent] = await db.select().from(schema.agentWallets).where(eq(schema.agentWallets.userId, req.userId!));
    const bal = agent ? await balance(config.SOLANA_RPC_URL, agent.publicKey).catch(() => 0) : 0;
    const netWorth = open.reduce((s, r) => s + Number(r.v ?? 0), 0) + bal;
    const cap = Math.max(20, netWorth * 5);
    const conds = [eq(w.feeChecked, true), sql`coalesce(${w.winRate}, 0) >= ${q.minWinRate}`, sql`${w.closedPositions} >= ${q.minPositions}`];
    if (q.active !== "any") conds.push(sql`${w.lastActiveAt} >= now() - ${q.active === "24h" ? sql`interval '1 day'` : q.active === "7d" ? sql`interval '7 days'` : sql`interval '30 days'`}`);
    if (q.minProfit !== undefined) conds.push(sql`${w.totalPnlSol} >= ${q.minProfit}`);
    if (q.minMonthly !== undefined) conds.push(sql`coalesce(${w.monthlySol}, 0) >= ${q.minMonthly}`);
    if (q.minEv !== undefined) conds.push(sql`coalesce(${w.evSol}, 0) >= ${q.minEv}`);
    if (q.minFees !== undefined) conds.push(sql`${w.feesSol} >= ${q.minFees}`);
    if (q.sizeToWallet === "true") conds.push(sql`${w.totalPnlSol} <= ${cap}`);
    const col = { pnl_all: w.totalPnlSol, pnl_7d: w.pnl7dSol, pnl_30d: w.pnl30dSol, win_rate: w.winRate, positions: w.closedPositions, fees: w.feesSol, monthly: w.monthlySol, ev: w.evSol, last_active: w.lastActiveAt, invested: w.avgInvestedSol }[q.sort];
    const rows = await db
      .select()
      .from(w)
      .where(and(...conds))
      .orderBy(q.dir === "desc" ? sql`${col} desc nulls last` : sql`${col} asc nulls last`)
      .limit(q.limit);
    const [{ n, updated } = { n: 0, updated: null }] = await db.select({ n: sql<number>`count(*)::int`, updated: sql<string | null>`max(${w.updatedAt})` }).from(w);
    const copied = new Set((await db.select({ a: schema.leaders.address }).from(schema.leaders).where(eq(schema.leaders.userId, req.userId!))).map((r) => r.a));
    return {
      indexed: n,
      updatedAt: updated,
      cap: q.sizeToWallet === "true" ? cap : null,
      netWorth,
      rows: rows.map((r) => ({
        address: r.address,
        totalPnl: Number(r.totalPnlSol),
        pnl7d: Number(r.pnl7dSol),
        pnl30d: Number(r.pnl30dSol),
        winRate: r.winRate === null ? null : Number(r.winRate),
        positions: r.closedPositions,
        openPools: r.openPools.length,
        fees: Number(r.feesSol),
        monthly: r.monthlySol === null ? null : Number(r.monthlySol),
        ev: r.evSol === null ? null : Number(r.evSol),
        avgInvested: r.avgInvestedSol === null ? null : Number(r.avgInvestedSol),
        openValue: Number(r.openValueSol),
        lastActiveAt: r.lastActiveAt,
        daily: r.daily ?? [],
        copied: copied.has(r.address),
      })),
    };
  });

  // ── Discover ───────────────────────────────────────────────────────────
  const DiscoverQuery = z.object({
    preset: z.enum(["trending", "new", "graduated", "fee_tvl", "rising", "smart", "nopool"]).default("trending"),
    hideRisky: z.enum(["true", "false"]).default("false"),
    q: z.string().max(64).optional(),
    minMcap: z.coerce.number().optional(),
    maxMcap: z.coerce.number().optional(),
    minLiquidity: z.coerce.number().optional(),
    minVolume: z.coerce.number().optional(),
    minHolders: z.coerce.number().optional(),
    maxAgeH: z.coerce.number().optional(),
    hasPool: z.enum(["any", "yes", "no"]).default("any"),
  });

  app.get("/v1/discover", async (req, reply) => {
    const q = DiscoverQuery.parse(req.query);
    try {
      let list: Json[];
      let floor: string | null = null;
      if (q.q?.trim()) list = await jup(`/search?query=${encodeURIComponent(q.q.trim())}`);
      else if (q.preset === "new") list = await jup(`/recent?limit=60`, 30_000);
      else if (q.preset === "graduated") {
        // Launchpad tokens that left the bonding curve, newest graduation first.
        const lists = await Promise.all(["/recent?limit=100", "/toptrending/1h?limit=100", "/toptraded/1h?limit=100", "/toporganicscore/1h?limit=100"].map((p) => jup(p, 60_000).catch(() => [] as Json[])));
        const seen = new Map<string, Json>();
        for (const t of lists.flat()) if (t.graduatedAt && !seen.has(String(t.id))) seen.set(String(t.id), t);
        list = [...seen.values()].sort((a, b) => Date.parse(b.graduatedAt) - Date.parse(a.graduatedAt));
      } else if (q.preset === "fee_tvl" || q.preset === "rising") {
        const pools = await meteora.pools({ protocol: "dlmm", page: 1, pageSize: 100, sort: `fee_tvl_ratio_${q.preset === "rising" ? "30m" : "1h"}:desc`, filter: `tvl>5000 && volume_1h>1000 && token_y=${SOL}` });
        let ranked = pools.data;
        if (q.preset === "rising") {
          // Fees rising: the last 30 minutes' Fee/TVL against the 30 minutes before.
          ranked = ranked.map((p) => ({ p, c: feeTvlChange(p.fee_tvl_ratio ?? {}, "30m") })).filter((x) => x.c !== null && x.c > 0).sort((a, b) => b.c! - a.c!).map((x) => x.p);
        }
        const mints = [...new Set(ranked.map((p) => String((p.token_x as Json)?.address)))].slice(0, 50);
        list = await tokensByMint(mints);
        const order = new Map(mints.map((m, i) => [m, i]));
        list.sort((a, b) => (order.get(String(a.id)) ?? 99) - (order.get(String(b.id)) ?? 99));
      } else if (q.preset === "smart") {
        const rows = await db.execute(sql`select t as mint, count(*)::int as n from ${schema.smartWallets}, unnest(${schema.smartWallets.openTokens}) as t group by t order by n desc limit 50`);
        list = await tokensByMint((rows as unknown as Array<{ mint: string }>).map((r) => r.mint));
      } else {
        // Trending: this hour's volume against the hour before, above a volume floor so dust can't top the list.
        floor = "1s hacmi ≥ $10k";
        list = (await jup(`/toptrending/1h?limit=100`)).filter((t) => num(t.stats1h?.buyVolume) + num(t.stats1h?.sellVolume) >= 10_000);
        list.sort((a, b) => num(b.stats1h?.volumeChange) - num(a.stats1h?.volumeChange));
      }
      list = list.filter((t) => t.id !== SOL).slice(0, 60);

      // Meteora pools of each token (count, best Fee/TVL, liquidity).
      const pools = new Map<string, Json[]>();
      const queue = [...list];
      await Promise.all(
        Array.from({ length: 6 }, async () => {
          for (let t = queue.shift(); t; t = queue.shift()) {
            const r = await meteora.pools({ protocol: "dlmm", page: 1, pageSize: 10, sort: "tvl:desc", query: String(t.id) }).catch(() => ({ data: [] as Json[] }));
            pools.set(String(t.id), r.data.filter((p) => (p.token_x as Json)?.address === t.id || (p.token_y as Json)?.address === t.id));
          }
        }),
      );
      const smartRows = list.length
        ? ((await db.execute(sql`select t as mint, count(*)::int as n from ${schema.smartWallets}, unnest(${schema.smartWallets.openTokens}) as t where t in ${list.map((t) => String(t.id))} group by t`)) as unknown as Array<{ mint: string; n: number }>)
        : [];
      const smart = new Map(smartRows.map((r) => [r.mint, r.n]));
      const now = Date.now();
      let rows = list.map((t) => {
        const ps = pools.get(String(t.id)) ?? [];
        const best = [...ps].sort((a, b) => num(b.fee_tvl_ratio?.["1h"]) - num(a.fee_tvl_ratio?.["1h"]))[0];
        const ft = (p: Json) => ({ "30m": num(p.fee_tvl_ratio?.["30m"]), "1h": num(p.fee_tvl_ratio?.["1h"]), "4h": num(p.fee_tvl_ratio?.["4h"]), "24h": num(p.fee_tvl_ratio?.["24h"]) });
        const ftc = (p: Json) => ({ "30m": feeTvlChange(p.fee_tvl_ratio ?? {}, "30m"), "1h": feeTvlChange(p.fee_tvl_ratio ?? {}, "1h"), "4h": feeTvlChange(p.fee_tvl_ratio ?? {}, "4h"), "24h": null });
        const price = num(t.usdPrice);
        const back = (c: unknown) => (c === undefined || c === null ? null : price / (1 + num(c) / 100));
        const score = safetyScore({ mintAuthority: t.mintAuthority ?? null, freezeAuthority: t.freezeAuthority ?? null, top10Pct: t.audit?.topHoldersPercentage ?? null, organicScore: t.organicScore ?? null, holders: t.holderCount ?? null });
        const created = t.firstPool?.createdAt ?? t.createdAt ?? null;
        return {
          mint: String(t.id),
          symbol: t.symbol as string,
          name: t.name as string,
          icon: (t.icon as string) ?? null,
          launchpad: (t.launchpad as string) ?? null,
          verified: Boolean(t.isVerified),
          createdAt: created,
          ageH: created ? (now - Date.parse(created)) / 3_600_000 : null,
          price,
          priceChange24h: num(t.stats24h?.priceChange),
          // Sparkline from Jupiter's change windows: price 24h, 6h, 1h and 5m ago, then now.
          spark: [back(t.stats24h?.priceChange), back(t.stats6h?.priceChange), back(t.stats1h?.priceChange), back(t.stats5m?.priceChange), price].filter((v): v is number => v !== null && Number.isFinite(v) && v > 0),
          volume5m: num(t.stats5m?.buyVolume) + num(t.stats5m?.sellVolume),
          volumeChange5m: t.stats5m?.volumeChange === undefined ? null : num(t.stats5m.volumeChange),
          graduatedAt: (t.graduatedAt as string) ?? null,
          mcap: num(t.mcap),
          holders: num(t.holderCount),
          volume24h: num(t.stats24h?.buyVolume) + num(t.stats24h?.sellVolume),
          volumeChange1h: num(t.stats1h?.volumeChange),
          volumeChange24h: num(t.stats24h?.volumeChange),
          organicScore: t.organicScore ?? null,
          top10Pct: t.audit?.topHoldersPercentage ?? null,
          devPct: t.audit?.devBalancePercentage ?? null,
          mintRevoked: !t.mintAuthority,
          freezeRevoked: !t.freezeAuthority,
          safety: score,
          safetyLabel: safetyLabel(score),
          smartLps: smart.get(String(t.id)) ?? 0,
          pools: ps.length,
          liquidity: ps.reduce((s, p) => s + num(p.tvl), 0),
          bestPool: best ? { address: String(best.address), feeTvl: ft(best), feeTvlChange: ftc(best), binStep: num(best.pool_config?.bin_step), tvl: num(best.tvl) } : null,
          poolList: ps.map((p) => ({ address: String(p.address), name: String(p.name), binStep: num(p.pool_config?.bin_step), baseFee: num(p.pool_config?.base_fee_pct), tvl: num(p.tvl), volume24h: num(p.volume?.["24h"]), fees24h: num(p.fees?.["24h"]), feeTvl: ft(p), feeTvlChange: ftc(p) })),
        };
      });
      if (q.preset === "nopool") rows = rows.filter((r) => r.pools === 0);
      if (q.preset === "fee_tvl") rows.sort((a, b) => (b.bestPool?.feeTvl["1h"] ?? 0) - (a.bestPool?.feeTvl["1h"] ?? 0));
      if (q.preset === "smart") rows.sort((a, b) => b.smartLps - a.smartLps);
      if (q.preset === "new") rows.sort((a, b) => (a.ageH ?? 1e9) - (b.ageH ?? 1e9));
      // Hide risky: drops scores under 40 and tokens with no audit data (no score to pass with).
      if (q.hideRisky === "true") rows = rows.filter((r) => r.safety !== null && r.safety >= 40);
      rows = rows.filter(
        (r) =>
          (q.minMcap === undefined || r.mcap >= q.minMcap) &&
          (q.maxMcap === undefined || r.mcap <= q.maxMcap) &&
          (q.minLiquidity === undefined || r.liquidity >= q.minLiquidity) &&
          (q.minVolume === undefined || r.volume24h >= q.minVolume) &&
          (q.minHolders === undefined || r.holders >= q.minHolders) &&
          (q.maxAgeH === undefined || (r.ageH !== null && r.ageH <= q.maxAgeH)) &&
          (q.hasPool === "any" || (q.hasPool === "yes") === r.pools > 0),
      );
      return { preset: q.preset, floor, updatedAt: new Date().toISOString(), rows };
    } catch (err) {
      return reply.code(502).send({ error: `veri alınamadı: ${(err as Error).message}` });
    }
  });
}

async function balance(url: string, address: string): Promise<number> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [address] }), signal: AbortSignal.timeout(8_000) });
  const b = (await res.json()) as { result?: { value: number } };
  return (b.result?.value ?? 0) / 1e9;
}
