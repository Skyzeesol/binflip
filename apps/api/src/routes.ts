import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";
import { Queue } from "bullmq";
import { QUEUES, type Config } from "@binflip/core";
import { schema, type Db } from "@binflip/db";
import { NonceStore, SESSION_TTL_MS, allowedOrigin, loginMessage, signSession, verifySession, verifySignature } from "./auth.js";
import { CopySettingsDto, fromRow, toRow } from "./settings.js";
import { Insights } from "./insights.js";

const COOKIE = "binflip_session";
const RANGES = { "7D": 7, "1M": 30, "3M": 90, "1Y": 365, YTD: -1, ALL: 36500 } as const;
/** Start of a range; YTD = Jan 1st (UTC) of the current year. */
function rangeStart(r: keyof typeof RANGES): Date {
  if (r === "YTD") return new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1));
  return new Date(Date.now() - RANGES[r] * 86_400_000);
}
const base58 = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);

declare module "fastify" {
  interface FastifyRequest {
    userId?: string;
  }
}

// Any Fastify instance (ours uses a pino logger instance, which narrows the generic).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerRoutes(app: FastifyInstance<any, any, any, any>, db: Db, config: Config) {
  const secret = config.SESSION_SECRET!;
  const nonces = new NonceStore();
  const origins = config.PANEL_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean);
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  const sol = (lamports: bigint | null) => (lamports === null ? null : Number(lamports) / 1e9);

  // ── Auth ───────────────────────────────────────────────────────────────
  app.post("/v1/auth/nonce", async (req, reply) => {
    const body = z.object({ wallet: base58, origin: z.string().optional() }).parse(req.body);
    const origin = allowedOrigin(body.origin ?? origins[0]!, origins);
    if (!origin) return reply.code(400).send({ error: `bu adres panele izinli değil (${body.origin}); sunucuda PANEL_ORIGINS'e ekleyin` });
    const { nonce, issuedAt } = nonces.issue(body.wallet, origin);
    return { nonce, message: loginMessage(body.wallet, nonce, issuedAt, origin) };
  });

  app.post("/v1/auth/verify", async (req, reply) => {
    const { wallet, nonce, signature } = z.object({ wallet: base58, nonce: z.string(), signature: z.string() }).parse(req.body);
    const n = nonces.take(nonce, wallet);
    if (!n || !verifySignature(loginMessage(wallet, nonce, n.issuedAt, n.origin), signature, wallet)) {
      return reply.code(401).send({ error: "imza doğrulanamadı" });
    }
    const [user] = await db.select().from(schema.users).where(eq(schema.users.loginWallet, wallet));
    if (!user) return reply.code(403).send({ error: "bu cüzdan panele kayıtlı değil" });
    reply.setCookie(COOKIE, signSession(user.id, secret), {
      httpOnly: true,
      sameSite: "strict",
      secure: config.NODE_ENV === "production",
      path: "/",
      maxAge: SESSION_TTL_MS / 1000,
    });
    return { ok: true };
  });

  app.post("/v1/auth/logout", async (_req, reply) => {
    reply.clearCookie(COOKIE, { path: "/" });
    return { ok: true };
  });

  // Everything below needs a session.
  app.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith("/v1/") || req.url.startsWith("/v1/auth/") || req.url === "/v1/status") return;
    const userId = verifySession(req.cookies[COOKIE], secret);
    if (!userId) return reply.code(401).send({ error: "giriş gerekli" });
    req.userId = userId;
  });

  // ── Me / status ────────────────────────────────────────────────────────
  app.get("/v1/me", async (req) => {
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, req.userId!));
    const wallets = await db.select().from(schema.agentWallets).where(eq(schema.agentWallets.userId, req.userId!));
    return {
      user: { id: user!.id, loginWallet: user!.loginWallet, role: user!.role },
      mode: config.mode,
      agentWallets: wallets.map((w) => ({ id: w.id, label: w.label, publicKey: w.publicKey })),
    };
  });

  // ── Leaders (Copied Wallets) ───────────────────────────────────────────
  app.get("/v1/leaders", async (req) => {
    const uid = req.userId!;
    const rows = await db
      .select()
      .from(schema.leaders)
      .innerJoin(schema.copySettings, eq(schema.copySettings.leaderId, schema.leaders.id))
      .where(eq(schema.leaders.userId, uid))
      .orderBy(schema.leaders.createdAt);
    const stats = await db
      .select({
        leaderId: schema.positions.leaderId,
        positions: sql<number>`count(*)::int`,
        pnl: sql<string>`coalesce(sum(coalesce(${schema.positions.currentValueSol}, 0) - ${schema.positions.depositedSol}::numeric / 1e9) filter (where ${schema.positions.depositedSol} > 0 and ${schema.positions.currentValueSol} is not null), 0)`,
      })
      .from(schema.positions)
      .where(eq(schema.positions.userId, uid))
      .groupBy(schema.positions.leaderId);
    const activity = await db
      .select({ leaderId: schema.leaderEvents.leaderId, last: sql<Date>`max(${schema.leaderEvents.createdAt})` })
      .from(schema.leaderEvents)
      .where(eq(schema.leaderEvents.userId, uid))
      .groupBy(schema.leaderEvents.leaderId);
    const st = new Map(stats.map((s) => [s.leaderId, s]));
    const act = new Map(activity.map((a) => [a.leaderId, a.last]));
    return rows.map(({ leaders: l, copy_settings: c }) => ({
      id: l.id,
      address: l.address,
      label: l.label,
      status: l.status,
      settings: fromRow(c),
      positions: st.get(l.id)?.positions ?? 0,
      pnlSol: Number(st.get(l.id)?.pnl ?? 0),
      lastActivity: act.get(l.id) ?? null,
    }));
  });

  app.post("/v1/leaders", async (req, reply) => {
    const body = z.object({ address: base58, label: z.string().min(1).max(60), settings: CopySettingsDto.optional() }).parse(req.body);
    const uid = req.userId!;
    const [l] = await db.insert(schema.leaders).values({ userId: uid, address: body.address, label: body.label }).onConflictDoNothing().returning();
    if (!l) return reply.code(409).send({ error: "bu cüzdan zaten listede" });
    // LP Agent defaults for a new copy: TP/SL 10/10, meme protection on, everything copied.
    const defaults = { sizingPercentBps: 10_000, takeProfitBps: 1000, stopLossBps: 1000 };
    await db.insert(schema.copySettings).values({ leaderId: l.id, userId: uid, ...defaults, ...toRow(body.settings ?? {}) });
    return { id: l.id };
  });

  app.patch("/v1/leaders/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const dto = CopySettingsDto.parse(req.body);
    const l = await ownLeader(db, req.userId!, id);
    if (!l) return reply.code(404).send({ error: "bulunamadı" });
    const [cs] = await db.select().from(schema.copySettings).where(eq(schema.copySettings.leaderId, id));
    const patch = toRow(dto, (cs?.managementParams as Record<string, unknown>) ?? {});
    if (Object.keys(patch).length) await db.update(schema.copySettings).set(patch).where(eq(schema.copySettings.leaderId, id));
    if (dto.label) await db.update(schema.leaders).set({ label: dto.label }).where(eq(schema.leaders.id, id));
    return { ok: true };
  });

  app.post("/v1/leaders/:id/:action", async (req, reply) => {
    const { id, action } = req.params as { id: string; action: string };
    if (action !== "pause" && action !== "resume") return reply.code(404).send({ error: "bilinmeyen işlem" });
    const l = await ownLeader(db, req.userId!, id);
    if (!l) return reply.code(404).send({ error: "bulunamadı" });
    await db.update(schema.leaders).set({ status: action === "pause" ? "paused" : "active" }).where(eq(schema.leaders.id, id));
    return { ok: true };
  });

  app.delete("/v1/leaders/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const l = await ownLeader(db, req.userId!, id);
    if (!l) return reply.code(404).send({ error: "bulunamadı" });
    // LP Agent "Stop copying": the wallet leaves the list; copies already open stay open.
    await db.delete(schema.leaders).where(eq(schema.leaders.id, id));
    return { ok: true };
  });

  // ── Copy dialog insights (suggested %, High-frequency warning) ─────────
  const insights = new Insights(db, config);
  app.get("/v1/insights", async (req) => {
    const { address } = z.object({ address: base58 }).parse(req.query);
    return insights.get(req.userId!, address, config.mode);
  });

  // ── Smart Token Retention: "Sell now" on a held token ─────────────────
  const swapQueue = new Queue(QUEUES.SWAPBACK, { connection: { url: config.REDIS_URL } as never });
  app.post("/v1/holdings/:txId/sell", async (req, reply) => {
    const { txId } = req.params as { txId: string };
    if (!z.string().uuid().safeParse(txId).success) return reply.code(404).send({ error: "bulunamadı" });
    const [r] = await db.select().from(schema.txs).where(and(eq(schema.txs.id, txId), eq(schema.txs.userId, req.userId!)));
    if (!r || r.reason !== "holding") return reply.code(409).send({ error: "bu token artık tutulmuyor" });
    const job = await swapQueue.getJob(r.idempotencyKey);
    if (!job || !(await job.isDelayed())) return reply.code(409).send({ error: "satış zaten başladı" });
    await db.update(schema.txs).set({ reason: "holding_sell_now" }).where(eq(schema.txs.id, r.id));
    await job.promote();
    return { ok: true };
  });

  // ── Copy Logs (last 7 days) ────────────────────────────────────────────
  app.get("/v1/logs", async (req) => {
    const q = z
      .object({ tab: z.enum(["all", "not_opened", "failed", "open", "closed"]).default("all"), leaderId: z.string().uuid().optional() })
      .parse(req.query);
    const since = new Date(Date.now() - 7 * 86_400_000);
    const rows = await db
      .select({
        tx: schema.txs,
        event: schema.leaderEvents,
        leader: { id: schema.leaders.id, label: schema.leaders.label, status: schema.leaders.status },
        position: schema.positions,
      })
      .from(schema.txs)
      .leftJoin(schema.leaderEvents, eq(schema.leaderEvents.id, schema.txs.leaderEventId))
      .leftJoin(schema.positions, eq(schema.positions.id, schema.txs.positionId))
      .leftJoin(schema.leaders, eq(schema.leaders.id, sql`coalesce(${schema.leaderEvents.leaderId}, ${schema.positions.leaderId})`))
      .where(
        and(
          eq(schema.txs.userId, req.userId!),
          gte(schema.txs.createdAt, since),
          q.leaderId ? eq(schema.leaders.id, q.leaderId) : undefined,
          q.tab === "not_opened" ? eq(schema.txs.status, "skipped") : undefined,
          q.tab === "failed" ? eq(schema.txs.status, "failed") : undefined,
          q.tab === "open" ? eq(schema.positions.state, "ACTIVE") : undefined,
          q.tab === "closed" ? eq(schema.positions.state, "CLOSED") : undefined,
        ),
      )
      .orderBy(desc(schema.txs.createdAt))
      .limit(300);
    return rows.map(({ tx, event, leader, position }) => ({
      id: tx.id,
      time: tx.createdAt,
      kind: tx.kind,
      result: resultLabel(tx.status, position?.state ?? null, tx.reason),
      status: tx.status,
      reason: tx.reason,
      error: tx.error,
      dryRun: tx.dryRun,
      solDelta: sol(tx.solDelta),
      feeSol: sol(tx.feeLamports),
      signature: tx.signature,
      plan: tx.plan,
      source: leader ? { id: leader.id, label: leader.label, status: leader.status, position: event?.leaderPosition ?? position?.leaderPosition ?? null } : { id: null, label: "manuel", status: null, position: null },
      position: position
        ? { id: position.id, pool: position.pool, state: position.state, ourPosition: position.ourPosition, depositedSol: sol(position.depositedSol), valueSol: num(position.currentValueSol), closeReason: position.closeReason }
        : null,
      leaderTx: event?.signature ?? null,
    }));
  });

  // ── Analysis ───────────────────────────────────────────────────────────
  app.get("/v1/analysis", async (req) => {
    const { range } = z.object({ range: z.enum(["7D", "1M", "3M", "1Y", "YTD", "ALL"]).default("1M") }).parse(req.query);
    const since = rangeStart(range);
    const uid = req.userId!;
    const per = await db
      .select({
        leaderId: schema.positions.leaderId,
        label: sql<string>`coalesce(${schema.leaders.label}, 'manuel')`,
        opened: sql<number>`count(*)::int`,
        open: sql<number>`count(*) filter (where ${schema.positions.state} = 'ACTIVE')::int`,
        deposited: sql<string>`coalesce(sum(${schema.positions.depositedSol}), 0)`,
        pnl: sql<string>`coalesce(sum(coalesce(${schema.positions.currentValueSol}, 0) - ${schema.positions.depositedSol}::numeric / 1e9) filter (where ${schema.positions.depositedSol} > 0 and ${schema.positions.currentValueSol} is not null), 0)`,
      })
      .from(schema.positions)
      .leftJoin(schema.leaders, eq(schema.leaders.id, schema.positions.leaderId))
      .where(and(eq(schema.positions.userId, uid), gte(schema.positions.createdAt, since)))
      .groupBy(schema.positions.leaderId, schema.leaders.label);
    const fees = await db
      .select({ total: sql<string>`coalesce(sum(${schema.txs.feeLamports}), 0)` })
      .from(schema.txs)
      .where(and(eq(schema.txs.userId, uid), gte(schema.txs.createdAt, since)));
    // Last snapshot per position per day, then summed per wallet (not every 5-minute sample).
    const seriesRows = await db.execute<{ day: string; leader_id: string | null; pnl: string }>(sql`
      select day, leader_id, sum(value_sol - deposited_sol) as pnl
      from (
        select distinct on (s.position_id, date_trunc('day', s.taken_at))
          to_char(date_trunc('day', s.taken_at), 'YYYY-MM-DD') as day,
          p.leader_id, s.value_sol, p.deposited_sol
        from ${schema.pnlSnapshots} s
        join ${schema.positions} p on p.id = s.position_id
        where s.user_id = ${uid} and s.taken_at >= ${since.toISOString()}::timestamptz
        order by s.position_id, date_trunc('day', s.taken_at), s.taken_at desc
      ) last_per_day
      group by day, leader_id
      order by day`);
    const series = (seriesRows as unknown as Array<{ day: string; leader_id: string | null; pnl: string }>).map((r) => ({ day: r.day, leaderId: r.leader_id, value: r.pnl }));
    const wallets = per.map((p) => ({ leaderId: p.leaderId, label: p.label, opened: p.opened, open: p.open, depositedSol: Number(p.deposited) / 1e9, pnlSol: Number(p.pnl) }));
    return {
      range,
      totals: {
        pnlSol: wallets.reduce((s, w) => s + w.pnlSol, 0),
        opened: wallets.reduce((s, w) => s + w.opened, 0),
        networkFeesSol: Number(fees[0]?.total ?? 0) / 1e9,
      },
      wallets,
      series: series.map((s) => ({ day: s.day, leaderId: s.leaderId, pnlSol: Number(s.value) / 1e9 })),
    };
  });

  // ── Positions ──────────────────────────────────────────────────────────
  app.get("/v1/positions", async (req) => {
    const { state } = z.object({ state: z.enum(["ACTIVE", "CLOSED", "all"]).default("ACTIVE") }).parse(req.query);
    const rows = await db
      .select({ p: schema.positions, label: schema.leaders.label })
      .from(schema.positions)
      .leftJoin(schema.leaders, eq(schema.leaders.id, schema.positions.leaderId))
      .where(and(eq(schema.positions.userId, req.userId!), state === "all" ? undefined : eq(schema.positions.state, state)))
      .orderBy(desc(schema.positions.createdAt))
      .limit(200);
    return rows.map(({ p, label }) => ({
      id: p.id,
      source: label ?? "manuel",
      pool: p.pool,
      ourPosition: p.ourPosition,
      leaderPosition: p.leaderPosition,
      state: p.state,
      dryRun: p.dryRun,
      strategy: p.strategy,
      managementMode: p.managementMode,
      range: [p.lowerBinId, p.upperBinId],
      depositedSol: sol(p.depositedSol),
      valueSol: num(p.currentValueSol),
      pnlPct: p.depositedSol > 0n && p.currentValueSol ? (Number(p.currentValueSol) / (Number(p.depositedSol) / 1e9) - 1) * 100 : null,
      flips: (p.simState as { flips?: number } | null)?.flips ?? null,
      openedAt: p.openedAt,
      closedAt: p.closedAt,
      closeReason: p.closeReason,
    }));
  });

  // ── Risk, kill switch, fund protection ─────────────────────────────────
  const RiskDto = z
    .object({
      maxSolPerTx: sol0(),
      maxSolPerDay: sol0(),
      fundProtectionEnabled: z.boolean(),
      fundProtectionLossPct: z.number().min(1).max(100),
      slippagePct: z.number().min(0.1).max(50),
      minOrganicScore: z.number().int().min(0).max(100).nullable(),
      minMarketCapUsd: z.number().int().min(0).nullable(),
      min24hVolumeUsd: z.number().int().min(0).nullable(),
      minHolders: z.number().int().min(0).nullable(),
      tokenBlacklist: z.array(base58).max(500),
    })
    .partial();

  app.get("/v1/risk", async (req) => {
    const r = await risk(db, req.userId!);
    return {
      killSwitch: r.killSwitch,
      killSwitchReason: r.killSwitchReason,
      maxSolPerTx: sol(r.maxSolPerTx),
      maxSolPerDay: sol(r.maxSolPerDay),
      fundProtectionEnabled: r.fundProtectionEnabled,
      fundProtectionLossPct: r.fundProtectionLossBps / 100,
      fundProtectionTrippedAt: r.fundProtectionTrippedAt,
      fundProtectionLimitSol: sol(r.fundProtectionLossSol),
      slippagePct: r.slippageBps / 100,
      minOrganicScore: r.minOrganicScore,
      minMarketCapUsd: r.minMarketCapUsd,
      min24hVolumeUsd: r.min24hVolumeUsd,
      minHolders: r.minHolders,
      tokenBlacklist: r.tokenBlacklist,
    };
  });

  app.patch("/v1/risk", async (req) => {
    const d = RiskDto.parse(req.body);
    const set: Partial<typeof schema.userRiskSettings.$inferInsert> = {};
    if (d.maxSolPerTx !== undefined) set.maxSolPerTx = BigInt(Math.round(d.maxSolPerTx * 1e9));
    if (d.maxSolPerDay !== undefined) set.maxSolPerDay = BigInt(Math.round(d.maxSolPerDay * 1e9));
    if (d.fundProtectionEnabled !== undefined) set.fundProtectionEnabled = d.fundProtectionEnabled;
    if (d.fundProtectionLossPct !== undefined) {
      set.fundProtectionLossBps = Math.round(d.fundProtectionLossPct * 100);
      // LP Agent: on save the % becomes a fixed SOL amount from that day's net worth and the count restarts.
      set.fundProtectionSince = new Date();
      set.fundProtectionTrippedAt = null;
      set.fundProtectionLossSol = null;
      set.fundProtectionPeakLamports = 0n;
    }
    if (d.slippagePct !== undefined) set.slippageBps = Math.round(d.slippagePct * 100);
    for (const k of ["minOrganicScore", "minMarketCapUsd", "min24hVolumeUsd", "minHolders", "tokenBlacklist"] as const) {
      if (d[k] !== undefined) (set as Record<string, unknown>)[k] = d[k];
    }
    await risk(db, req.userId!);
    await db.update(schema.userRiskSettings).set(set).where(eq(schema.userRiskSettings.userId, req.userId!));
    return { ok: true };
  });

  app.post("/v1/kill", async (req) => {
    const { reason } = z.object({ reason: z.string().max(200).optional() }).parse(req.body ?? {});
    await risk(db, req.userId!);
    await db.update(schema.userRiskSettings).set({ killSwitch: true, killSwitchReason: reason ?? "panel" }).where(eq(schema.userRiskSettings.userId, req.userId!));
    return { ok: true };
  });

  // LP Agent "Resume": start again with the same limit and a fresh count.
  app.post("/v1/fund-protection/resume", async (req) => {
    await db
      .update(schema.userRiskSettings)
      .set({ fundProtectionTrippedAt: null, fundProtectionSince: new Date(), fundProtectionPeakLamports: 0n })
      .where(eq(schema.userRiskSettings.userId, req.userId!));
    return { ok: true };
  });

  app.post("/v1/unkill", async (req) => {
    await db.update(schema.userRiskSettings).set({ killSwitch: false, killSwitchReason: null }).where(eq(schema.userRiskSettings.userId, req.userId!));
    return { ok: true };
  });

  // ── Manual positions ───────────────────────────────────────────────────
  app.get("/v1/manual", async (req) => {
    const [m] = await db.select().from(schema.manualSettings).where(eq(schema.manualSettings.userId, req.userId!));
    return {
      enabled: m?.enabled ?? true,
      mode: m?.managementMode ?? "staged_flip",
      flipThresholdPct: ((m?.managementParams as { flipThresholdBps?: number } | undefined)?.flipThresholdBps ?? 1000) / 100,
      takeProfitPct: m?.takeProfitBps != null ? m.takeProfitBps / 100 : null,
      stopLossPct: m?.stopLossBps != null ? m.stopLossBps / 100 : null,
      trailingStopPct: m?.trailingStopBps != null ? m.trailingStopBps / 100 : null,
      compoundMinutes: m?.compoundIntervalMinutes ?? null,
    };
  });

  app.put("/v1/manual", async (req) => {
    const d = z
      .object({
        enabled: z.boolean(),
        mode: z.enum(["mirror", "staged_flip", "bottom_flip", "precision_hybrid"]),
        flipThresholdPct: z.number().min(1).max(90),
        takeProfitPct: z.number().min(0).nullable(),
        stopLossPct: z.number().min(0).nullable(),
        trailingStopPct: z.number().min(0).nullable(),
        compoundMinutes: z.number().int().min(5).nullable(),
      })
      .parse(req.body);
    const bps = (v: number | null) => (v === null ? null : Math.round(v * 100));
    const v = {
      userId: req.userId!,
      enabled: d.enabled,
      managementMode: d.mode,
      managementParams: { flipThresholdBps: Math.round(d.flipThresholdPct * 100) },
      takeProfitBps: bps(d.takeProfitPct),
      stopLossBps: bps(d.stopLossPct),
      trailingStopBps: bps(d.trailingStopPct),
      compoundIntervalMinutes: d.compoundMinutes,
    };
    await db.insert(schema.manualSettings).values(v).onConflictDoUpdate({ target: schema.manualSettings.userId, set: v });
    return { ok: true };
  });

  // Validation errors → 400 with a readable message.
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof z.ZodError) return reply.code(400).send({ error: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    app.log.error({ err: err instanceof Error ? err.message : String(err) }, "request failed");
    return reply.code(500).send({ error: "sunucu hatası" });
  });
}

function sol0() {
  return z.number().positive().max(100_000);
}

/** LP Agent: "Not opened" = the copy could not open (funds, limits); "Skipped" = your settings turned it down. */
const NOT_OPENED = new Set([
  "low_balance",
  "copy_size_zero",
  "no_sizing_rule",
  "position_cap_reached",
  "daily_limit",
  "fund_protection",
  "kill_switch",
  "non_sol_pair",
  "damm_live_not_supported",
  "send_failed",
]);

function resultLabel(status: string, positionState: string | null, reason: string | null = null): string {
  if (reason === "holding" && status === "planned") return "Holding";
  if (status === "skipped") return reason && NOT_OPENED.has(reason) ? "NotOpened" : "Skipped";
  if (status === "failed") return "Failed";
  if (status === "planned" || status === "submitted" || status === "simulated") return positionState === "ACTIVE" ? "Open" : "Pending";
  if (positionState === "HOLDING") return "Holding";
  if (positionState === "CLOSED") return "Closed";
  return "Open";
}

async function ownLeader(db: Db, userId: string, id: string) {
  if (!z.string().uuid().safeParse(id).success) return null;
  const [l] = await db.select().from(schema.leaders).where(and(eq(schema.leaders.id, id), eq(schema.leaders.userId, userId)));
  return l ?? null;
}

async function risk(db: Db, userId: string) {
  const [r] = await db.select().from(schema.userRiskSettings).where(eq(schema.userRiskSettings.userId, userId));
  if (r) return r;
  await db.insert(schema.userRiskSettings).values({ userId }).onConflictDoNothing();
  return (await db.select().from(schema.userRiskSettings).where(eq(schema.userRiskSettings.userId, userId)))[0]!;
}
