import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { Queue } from "bullmq";
import { QUEUES, TokenInfoClient, WSOL_MINT, type Config, type ManagementJob, type TokenInfo, type WithdrawJob } from "@binflip/core";
import { schema, type Db } from "@binflip/db";
import { history, positionMetrics, rangeVsPrice, summarize, type Group } from "./portfolioMath.js";

type Pos = typeof schema.positions.$inferSelect;

const RANGE_DAYS = { "7D": 7, MTD: -2, "1M": 30, "3M": 90, "1Y": 365, YTD: -1, ALL: 36500 } as const;
function since(r: keyof typeof RANGE_DAYS): Date {
  const now = new Date();
  if (r === "YTD") return new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  if (r === "MTD") return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return new Date(Date.now() - RANGE_DAYS[r] * 86_400_000);
}

const n = (v: string | null | undefined) => (v === null || v === undefined ? null : Number(v));

/**
 * LP Agent "Portfolio" + "Manage Positions" + account panel, for the agent wallet.
 * Actions on live positions are queued for the executor (which holds the key);
 * dry-run positions are updated here directly, since nothing touches the chain.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerPortfolio(app: FastifyInstance<any, any, any, any>, db: Db, config: Config) {
  const tokens = new TokenInfoClient();
  const conn = { connection: { url: config.REDIS_URL } as never };
  const management = new Queue<ManagementJob>(QUEUES.MANAGEMENT, conn);
  const account = new Queue<WithdrawJob>(QUEUES.ACCOUNT, conn);
  const notifications = new Queue(QUEUES.NOTIFICATIONS, conn);

  async function tokenMap(mints: string[]): Promise<Map<string, TokenInfo>> {
    const uniq = [...new Set(mints.filter(Boolean))];
    const out = new Map<string, TokenInfo>();
    await Promise.all(
      uniq.map(async (m) => {
        try {
          out.set(m, await tokens.get(m));
        } catch {
          /* no token data: show the address */
        }
      }),
    );
    return out;
  }

  function view(p: Pos, label: string | null, tok: Map<string, TokenInfo>, now = new Date()) {
    const invested = Number(p.depositedSol) / 1e9;
    const m = positionMetrics(
      {
        invested,
        value: n(p.currentValueSol),
        claimedFee: Number(p.claimedFeeSol),
        compoundedFee: Number(p.compoundedFeeSol),
        unclaimedFee: n(p.unclaimedFeeSol) ?? 0,
        openedAt: p.openedAt ?? p.createdAt,
        closedAt: p.closedAt,
      },
      now,
    );
    const tokenMint = p.mintX === WSOL_MINT ? p.mintY : p.mintX;
    const t = tokenMint ? tok.get(tokenMint) : undefined;
    return {
      id: p.id,
      protocol: p.protocol,
      pool: p.pool,
      position: p.ourPosition,
      leaderPosition: p.leaderPosition,
      source: p.leaderId ? "auto" : "manual",
      leaderLabel: label,
      dryRun: p.dryRun,
      state: p.state,
      strategy: p.strategy,
      managementMode: p.managementMode,
      token: tokenMint ? { mint: tokenMint, symbol: t?.symbol ?? null, icon: t?.icon ?? null, holders: t?.holders ?? null } : null,
      invested,
      value: n(p.currentValueSol),
      claimedFee: Number(p.claimedFeeSol),
      unclaimedFee: n(p.unclaimedFeeSol),
      ...m,
      range: rangeVsPrice(p.lowerBinId, p.upperBinId, p.activeBinId, p.binStep),
      bins: { lower: p.lowerBinId, upper: p.upperBinId, active: p.activeBinId, binStep: p.binStep },
      exits: { takeProfitPct: p.takeProfitBps === null ? null : p.takeProfitBps / 100, stopLossPct: p.stopLossBps === null ? null : p.stopLossBps / 100, trailingPct: p.trailingStopBps === null ? null : p.trailingStopBps / 100 },
      flips: (p.simState as { flips?: number } | null)?.flips ?? null,
      openedAt: p.openedAt ?? p.createdAt,
      closedAt: p.closedAt,
      closeReason: p.closeReason,
    };
  }

  async function rows(userId: string, where: ReturnType<typeof and> | undefined) {
    return db
      .select({ p: schema.positions, label: schema.leaders.label })
      .from(schema.positions)
      .leftJoin(schema.leaders, eq(schema.leaders.id, schema.positions.leaderId))
      .where(and(eq(schema.positions.userId, userId), where))
      .orderBy(desc(schema.positions.createdAt));
  }

  const Query = z.object({
    range: z.enum(["7D", "MTD", "1M", "3M", "1Y", "YTD", "ALL"]).default("1M"),
    group: z.enum(["day", "week", "month"]).default("day"),
    protocol: z.enum(["all", "dlmm", "damm_v2"]).default("all"),
  });

  // ── Header metrics + profit history ────────────────────────────────────
  app.get("/v1/portfolio", async (req) => {
    const q = Query.parse(req.query);
    const all = await rows(req.userId!, q.protocol === "all" ? undefined : eq(schema.positions.protocol, q.protocol));
    const now = new Date();
    const views = all.map(({ p }) => ({ p, m: view(p, null, new Map(), now) }));
    const closed = views.filter((v) => v.p.state === "CLOSED" && v.p.depositedSol > 0n);
    const open = views.filter((v) => v.p.state !== "CLOSED");
    const fees = views.reduce((s, v) => s + v.m.totalFee, 0);
    const summary = summarize(closed.map((v) => ({ invested: v.m.invested, pnl: v.m.pnl, firstAt: v.m.openedAt })), fees, now);
    const from = since(q.range);
    const inRange = closed.filter((v) => v.p.closedAt && v.p.closedAt >= from);
    return {
      summary,
      openValue: open.reduce((s, v) => s + (v.m.value ?? 0), 0),
      openUnclaimed: open.reduce((s, v) => s + (v.m.unclaimedFee ?? 0), 0),
      history: {
        pnl: history(inRange.map((v) => ({ at: v.p.closedAt!, value: v.m.pnl ?? 0 })), q.group as Group),
        fee: history(inRange.map((v) => ({ at: v.p.closedAt!, value: v.m.totalFee })), q.group as Group),
      },
      // Calendar: one value per day over the range, PnL of positions closed that day.
      days: history(inRange.map((v) => ({ at: v.p.closedAt!, value: v.m.pnl ?? 0 })), "day"),
      feeDays: history(inRange.map((v) => ({ at: v.p.closedAt!, value: v.m.totalFee })), "day"),
      from,
    };
  });

  // ── Open / historical positions ────────────────────────────────────────
  const ListQuery = z.object({
    status: z.enum(["open", "closed"]).default("open"),
    protocol: z.enum(["all", "dlmm", "damm_v2"]).default("all"),
    source: z.enum(["all", "auto", "manual"]).default("all"),
    pool: z.string().optional(),
    minPnl: z.coerce.number().optional(),
    maxPnl: z.coerce.number().optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  });

  app.get("/v1/portfolio/positions", async (req) => {
    const q = ListQuery.parse(req.query);
    const conds = [q.status === "open" ? inArray(schema.positions.state, ["OPENING", "ACTIVE", "FLIPPING", "CLOSING", "HOLDING"]) : eq(schema.positions.state, "CLOSED")];
    if (q.protocol !== "all") conds.push(eq(schema.positions.protocol, q.protocol));
    if (q.pool) conds.push(eq(schema.positions.pool, q.pool));
    let list = await rows(req.userId!, and(...conds));
    if (q.source !== "all") list = list.filter(({ p }) => (q.source === "auto") === (p.leaderId !== null));
    if (q.status === "closed") list.sort((a, b) => (b.p.closedAt?.getTime() ?? 0) - (a.p.closedAt?.getTime() ?? 0));
    const tok = await tokenMap(list.flatMap(({ p }) => [p.mintX, p.mintY].filter((m): m is string => !!m && m !== WSOL_MINT)));
    let out = list.slice(0, q.limit).map(({ p, label }) => view(p, label, tok));
    if (q.minPnl !== undefined) out = out.filter((v) => v.pnl !== null && v.pnl >= q.minPnl!);
    if (q.maxPnl !== undefined) out = out.filter((v) => v.pnl !== null && v.pnl <= q.maxPnl!);
    const pools = [...new Map(list.map(({ p }) => [p.pool, { pool: p.pool, token: view(p, null, tok).token?.symbol ?? null }])).values()];
    return { positions: out, pools };
  });

  // ── Position details: numbers, bins, history, logs ─────────────────────
  app.get("/v1/portfolio/positions/:id", async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const [r] = await rows(req.userId!, eq(schema.positions.id, id));
    if (!r) return reply.code(404).send({ error: "pozisyon bulunamadı" });
    const tok = await tokenMap([r.p.mintX, r.p.mintY].filter((m): m is string => !!m && m !== WSOL_MINT));
    const txs = await db.select().from(schema.txs).where(eq(schema.txs.positionId, id)).orderBy(asc(schema.txs.createdAt));
    const snaps = await db
      .select({ at: schema.pnlSnapshots.takenAt, value: schema.pnlSnapshots.valueSol })
      .from(schema.pnlSnapshots)
      .where(eq(schema.pnlSnapshots.positionId, id))
      .orderBy(asc(schema.pnlSnapshots.takenAt))
      .limit(2000);
    const sim = r.p.simState as { bins?: Array<{ id: number; x: number; y: number }>; activeId?: number } | null;
    const bins = (r.p.dryRun ? sim?.bins : r.p.chainBins) ?? [];
    return {
      position: view(r.p, r.label, tok),
      chart: {
        active: r.p.activeBinId ?? sim?.activeId ?? null,
        bins: bins.filter((b) => b.x > 0 || b.y > 0).map((b) => ({ id: b.id, x: b.x, y: b.y })),
      },
      value: snaps.map((s) => ({ at: s.at, value: Number(s.value) / 1e9 })),
      history: txs
        .filter((t) => t.status !== "skipped")
        .map((t) => ({
          at: t.createdAt,
          kind: t.kind,
          status: t.status,
          reason: t.reason,
          signature: t.signature,
          signatures: ((t.plan as { signatures?: string[] } | null)?.signatures ?? (t.signature ? [t.signature] : [])) as string[],
          solDelta: t.solDelta === null ? null : Number(t.solDelta) / 1e9,
          feeLamports: t.feeLamports === null ? null : Number(t.feeLamports),
          dryRun: t.dryRun,
        })),
      logs: txs.map((t) => ({ at: t.updatedAt ?? t.createdAt, kind: t.kind, status: t.status, reason: t.reason, error: t.error })),
    };
  });

  // ── Manage Positions: zap out, decrease, claim, compound ───────────────
  const Action = z.object({
    kind: z.enum(["close", "decrease", "claim", "compound"]),
    pct: z.number().min(1).max(100).optional(),
    swapToSol: z.boolean().default(true),
  });

  app.post("/v1/portfolio/positions/:id/action", async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const a = Action.parse(req.body);
    const [pos] = await db.select().from(schema.positions).where(and(eq(schema.positions.id, id), eq(schema.positions.userId, req.userId!)));
    if (!pos) return reply.code(404).send({ error: "pozisyon bulunamadı" });
    if (pos.state !== "ACTIVE") return reply.code(409).send({ error: "pozisyon açık değil" });
    if (a.kind === "compound" && pos.protocol !== "dlmm") return reply.code(400).send({ error: "compound sadece DLMM'de" });
    const bps = a.kind === "decrease" ? Math.round((a.pct ?? 100) * 100) : 10_000;
    const kind: ManagementJob["kind"] = a.kind === "decrease" && bps >= 10_000 ? "close" : a.kind;
    const requestId = randomUUID();
    const key = `manual_${pos.id}_${kind}_${requestId.slice(0, 8)}`;

    if (pos.dryRun) {
      await applyDryRun(pos, kind, bps, a.swapToSol, key);
      return { ok: true, dryRun: true };
    }
    await management.add("manage", { positionId: pos.id, kind, reason: "manual", activeId: pos.activeBinId ?? 0, manual: true, bps, swapToSol: a.swapToSol }, { jobId: key, attempts: 1, removeOnComplete: { age: 86_400 } });
    return { ok: true, queued: true };
  });

  async function applyDryRun(pos: Pos, kind: ManagementJob["kind"], bps: number, swapToSol: boolean, key: string) {
    const txKind = kind === "decrease" ? "remove" : kind === "claim" ? "claim" : kind === "compound" ? "compound" : "close";
    await db.insert(schema.txs).values({ userId: pos.userId, positionId: pos.id, idempotencyKey: key, kind: txKind, status: "planned", reason: "manual", dryRun: true, plan: { bps, swapToSol } as never }).onConflictDoNothing();
    const value = n(pos.currentValueSol);
    if (kind === "close") {
      await db.update(schema.positions).set({ state: "CLOSED", closedAt: new Date(), closeReason: "manual" }).where(eq(schema.positions.id, pos.id));
    } else if (kind === "decrease") {
      const keep = 1 - bps / 10_000;
      const sim = pos.simState as { bins?: Array<{ id: number; x: number; y: number }>; depositedY?: number } | null;
      await db
        .update(schema.positions)
        .set({
          depositedSol: BigInt(Math.round(Number(pos.depositedSol) * keep)),
          currentValueSol: value === null ? null : String(value * keep),
          simState: sim ? ({ ...sim, depositedY: (sim.depositedY ?? 0) * keep, bins: (sim.bins ?? []).map((b) => ({ ...b, x: b.x * keep, y: b.y * keep })) } as never) : null,
        })
        .where(eq(schema.positions.id, pos.id));
    }
    const what = kind === "close" ? "kapatma (SOL'e)" : kind === "decrease" ? `%${bps / 100} azaltma` : kind === "claim" ? "fee claim" : "compound";
    await notifications.add("notify", { userId: pos.userId, text: `[DENEME] Panelden ${what} istendi → yapardım.` }, { removeOnComplete: 1000 });
  }

  // ── Take profit / stop loss on one position ────────────────────────────
  const Exits = z.object({
    takeProfitPct: z.number().min(0.1).max(10_000).nullable(),
    stopLossPct: z.number().min(0.1).max(100).nullable(),
    trailingPct: z.number().min(0.1).max(100).nullable(),
  });
  app.put("/v1/portfolio/positions/:id/exits", async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const e = Exits.parse(req.body);
    const toBps = (v: number | null) => (v === null ? null : Math.round(v * 100));
    const res = await db
      .update(schema.positions)
      .set({ takeProfitBps: toBps(e.takeProfitPct), stopLossBps: toBps(e.stopLossPct), trailingStopBps: toBps(e.trailingPct), exitRulesSaved: true })
      .where(and(eq(schema.positions.id, id), eq(schema.positions.userId, req.userId!)))
      .returning({ id: schema.positions.id });
    if (!res.length) return reply.code(404).send({ error: "pozisyon bulunamadı" });
    return { ok: true };
  });

  // ── Account panel: agent wallet balances, withdraw to the main wallet ──
  async function rpc<T>(method: string, params: unknown[]): Promise<T> {
    const res = await fetch(config.SOLANA_RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json()) as { result?: T; error?: { message: string } };
    if (body.error) throw new Error(body.error.message);
    return body.result as T;
  }

  let solPrice: { at: number; usd: number | null } = { at: 0, usd: null };
  async function solUsd(): Promise<number | null> {
    if (Date.now() - solPrice.at < 60_000) return solPrice.usd;
    try {
      solPrice = { at: Date.now(), usd: (await tokens.get(WSOL_MINT)).usdPrice };
    } catch {
      solPrice = { at: Date.now(), usd: solPrice.usd };
    }
    return solPrice.usd;
  }

  app.get("/v1/prices/sol", async () => ({ usd: await solUsd() }));

  app.get("/v1/account", async (req) => {
    const [w] = await db.select().from(schema.agentWallets).where(eq(schema.agentWallets.userId, req.userId!));
    const open = await db.select().from(schema.positions).where(and(eq(schema.positions.userId, req.userId!), inArray(schema.positions.state, ["OPENING", "ACTIVE", "FLIPPING", "CLOSING", "HOLDING"])));
    const positionsValue = open.reduce((s, p) => s + (n(p.currentValueSol) ?? 0), 0);
    const usd = await solUsd();
    const base = { wallet: w?.publicKey ?? null, mainWallet: config.SWEEP_TO_ADDRESS ?? null, solUsd: usd, positionsValue, mode: config.mode };
    if (!w) return { ...base, sol: null, tokens: [], tokensValue: 0, netWorth: positionsValue };
    try {
      const bal = await rpc<{ value: number }>("getBalance", [w.publicKey, { commitment: "confirmed" }]);
      const accounts = (
        await Promise.all(
          ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"].map((programId) =>
            rpc<{ value: Array<{ account: { data: { parsed: { info: { mint: string; tokenAmount: { uiAmount: number; amount: string } } } } } }> }>("getTokenAccountsByOwner", [
              w.publicKey,
              { programId },
              { encoding: "jsonParsed", commitment: "confirmed" },
            ]),
          ),
        )
      ).flatMap((r) => r.value);
      const held = accounts.map((a) => a.account.data.parsed.info).filter((i) => i.tokenAmount.uiAmount > 0);
      const tok = await tokenMap(held.map((h) => h.mint));
      const list = held.map((h) => {
        const t = tok.get(h.mint);
        const valueUsd = t?.usdPrice ? t.usdPrice * h.tokenAmount.uiAmount : null;
        return { mint: h.mint, symbol: t?.symbol ?? null, icon: t?.icon ?? null, amount: h.tokenAmount.uiAmount, valueSol: valueUsd !== null && usd ? valueUsd / usd : null };
      });
      const sol = bal.value / 1e9;
      const tokensValue = list.reduce((s, t) => s + (t.valueSol ?? 0), 0);
      // LP Agent: Total Net Worth = tokens held + open positions + unclaimed fees (+ rent, inside position value).
      return { ...base, sol, tokens: list, tokensValue, netWorth: sol + tokensValue + positionsValue, emptyAccounts: accounts.length - held.length };
    } catch (err) {
      return { ...base, sol: null, tokens: [], tokensValue: 0, netWorth: positionsValue, error: (err as Error).message };
    }
  });

  app.post("/v1/account/withdraw", async (req, reply) => {
    const body = z.object({ amountSol: z.union([z.number().positive(), z.literal("max")]) }).parse(req.body);
    if (config.mode !== "live" && !(await liveWallet(req.userId!))) return reply.code(400).send({ error: "deneme modunda bot cüzdanı yok" });
    if (!config.SWEEP_TO_ADDRESS) return reply.code(400).send({ error: "sunucuda ana cüzdan adresi (SWEEP_TO_ADDRESS) yok" });
    const requestId = randomUUID();
    const lamports = body.amountSol === "max" ? "max" : String(Math.round(body.amountSol * 1e9));
    await account.add("withdraw", { userId: req.userId!, lamports, requestId }, { jobId: `withdraw_${requestId}`, attempts: 1, removeOnComplete: { age: 86_400 } });
    return { ok: true, to: config.SWEEP_TO_ADDRESS };
  });

  async function liveWallet(userId: string) {
    const [w] = await db.select().from(schema.agentWallets).where(eq(schema.agentWallets.userId, userId));
    return w ?? null;
  }
}
