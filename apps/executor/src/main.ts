import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import {
  LAMPORTS_PER_SOL,
  QUEUES,
  planCopy,
  runService,
  type ExecutionJob,
  type LeaderAction,
  type NotificationJob,
  type Plan,
  type Strategy,
} from "@binflip/core";
import { createDb, schema, type Db } from "@binflip/db";

/**
 * executor — turns stored leader events into our actions.
 * Stage 2 (dry-run): plan only, record "planned" txs and mirror positions in
 * the DB so later adds/closes of the same leader position size correctly.
 * Signing and sending lands in stage 3; until then live mode refuses to act.
 */
await runService("executor", async ({ config, log }) => {
  const { db, ping, close } = createDb(config.DATABASE_URL, { max: 5 });
  const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  const notifications = new Queue<NotificationJob>(QUEUES.NOTIFICATIONS, { connection });

  const worker = new Worker<ExecutionJob>(
    QUEUES.EXECUTION,
    async (job) => {
      const result = await handleEvent(db, job.data.leaderEventId, config.mode);
      if (!result) return { duplicate: true };
      const { plan, action, leaderLabel, userId, text } = result;
      log.info(
        { leader: leaderLabel, kind: action.kind, plan: plan.do, reason: plan.do === "skip" ? plan.reason : undefined, position: action.position },
        text,
      );
      await notifications.add("notify", { userId, text }, { removeOnComplete: 1000 });
      return { plan: plan.do };
    },
    { connection, concurrency: 1 }, // serial: positions and daily limits must not race
  );
  worker.on("failed", (job, err) => log.error({ event: job?.data.leaderEventId, err: err.message }, "plan failed"));

  await ping();
  return {
    checks: { postgres: ping, redis: async () => void (await connection.ping()) },
    cleanups: [() => close(), async () => void (await connection.quit()), () => notifications.close(), () => worker.close()],
  };
});

async function handleEvent(db: Db, eventId: string, mode: "dry_run" | "live") {
  const [row] = await db
    .select()
    .from(schema.leaderEvents)
    .innerJoin(schema.leaders, eq(schema.leaders.id, schema.leaderEvents.leaderId))
    .innerJoin(schema.copySettings, eq(schema.copySettings.leaderId, schema.leaders.id))
    .where(eq(schema.leaderEvents.id, eventId));
  if (!row) throw new Error(`leader event ${eventId} or its copy settings not found`);
  const ev = row.leader_events;
  const leader = row.leaders;
  const cs = row.copy_settings;

  const risk = await getRisk(db, ev.userId);
  const action = toAction(ev.payload);
  const ours = ev.leaderPosition
    ? (
        await db
          .select()
          .from(schema.positions)
          .where(and(eq(schema.positions.userId, ev.userId), eq(schema.positions.leaderPosition, ev.leaderPosition)))
      )[0] ?? null
    : null;

  const spentToday = await solSpentToday(db, ev.userId);
  const plan = planCopy(
    action,
    {
      sizing: {
        mode: cs.sizingMode,
        percentBps: cs.sizingPercentBps,
        fixedSol: cs.sizingFixedSol,
        maxPerAdd: cs.maxSolPerAdd,
        maxPerPosition: cs.maxSolPerPosition,
      },
      copyDlmmStrategies: cs.copyDlmmStrategies as Strategy[],
      copyDammV2: cs.copyDammV2,
      memeProtection: cs.memeProtection,
      leaderPaused: leader.status === "paused",
      followExitsWhilePaused: cs.followExitsWhilePaused,
      killSwitch: risk.killSwitch,
      fundProtectionTripped: risk.fundProtectionTrippedAt !== null,
      maxSolPerTx: risk.maxSolPerTx,
      dailyRoom: risk.maxSolPerDay - spentToday,
    },
    ours && {
      id: ours.id,
      state: ours.state,
      depositedSol: ours.depositedSol,
      ratioPpm: ours.sizeRatioPpm,
      fundedAt: ours.fundedAt,
      lowerBinId: ours.lowerBinId,
      upperBinId: ours.upperBinId,
    },
  );

  // Live execution is stage 3: record the intent but refuse to act.
  const liveBlocked = mode === "live" && plan.do !== "skip";
  const dryRun = mode === "dry_run";

  const inserted = await db.transaction(async (tx) => {
    const [t] = await tx
      .insert(schema.txs)
      .values({
        userId: ev.userId,
        positionId: ours?.id ?? null,
        leaderEventId: ev.id,
        idempotencyKey: `event_${ev.id}`,
        kind: plan.do === "skip" ? action.kind : plan.do,
        status: plan.do === "skip" || liveBlocked ? "skipped" : "planned",
        reason: plan.do === "skip" ? plan.reason : liveBlocked ? "live_not_implemented" : null,
        dryRun,
        solDelta: "amountSol" in plan ? -plan.amountSol : null,
        plan: jsonSafe({ plan, action: { kind: action.kind, strategy: action.strategy, bins: [action.lowerBinId, action.upperBinId] } }),
      })
      .onConflictDoNothing()
      .returning({ id: schema.txs.id });
    if (!t) return false; // already handled

    if (!liveBlocked) await applyToPositions(tx as unknown as Db, plan, action, ev, cs.managementMode, ours?.id ?? null, dryRun, t.id);
    await tx.update(schema.leaderEvents).set({ processedAt: new Date() }).where(eq(schema.leaderEvents.id, ev.id));
    return true;
  });
  if (!inserted) return null;

  return { plan, action, leaderLabel: leader.label, userId: ev.userId, text: describe(leader.label, action, plan, dryRun, liveBlocked) };
}

/** Mirror the plan onto our positions table (dry-run positions included). */
async function applyToPositions(
  db: Db,
  plan: Plan,
  a: LeaderAction,
  ev: typeof schema.leaderEvents.$inferSelect,
  mgmt: (typeof schema.managementMode.enumValues)[number],
  ourId: string | null,
  dryRun: boolean,
  txId: string,
) {
  const now = new Date();
  if (plan.do === "open") {
    const [p] = await db
      .insert(schema.positions)
      .values({
        userId: ev.userId,
        leaderId: ev.leaderId,
        protocol: a.protocol,
        pool: a.pool ?? "unknown",
        leaderPosition: a.position,
        state: plan.empty ? "OPENING" : "ACTIVE",
        dryRun,
        strategy: a.strategy,
        managementMode: mgmt,
        lowerBinId: a.lowerBinId,
        upperBinId: a.upperBinId,
        entryActiveBinId: a.activeBinId,
        sizeRatioPpm: plan.ratioPpm,
        depositedSol: plan.amountSol,
        fundedAt: plan.empty ? null : now,
        openedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: schema.positions.id });
    if (p) await db.update(schema.txs).set({ positionId: p.id }).where(eq(schema.txs.id, txId));
    return;
  }
  if (!ourId) return;
  if (plan.do === "add") {
    await db
      .update(schema.positions)
      .set({
        state: "ACTIVE",
        depositedSol: sql`${schema.positions.depositedSol} + ${plan.amountSol}`,
        ...(plan.firstFunding
          ? { sizeRatioPpm: plan.ratioPpm, fundedAt: now, strategy: a.strategy, entryActiveBinId: a.activeBinId }
          : {}),
        ...(a.lowerBinId !== null ? { lowerBinId: a.lowerBinId, upperBinId: a.upperBinId } : {}),
      })
      .where(eq(schema.positions.id, ourId));
  } else if (plan.do === "close") {
    await db
      .update(schema.positions)
      .set({ state: "CLOSED", closedAt: now, closeReason: "leader_exit" })
      .where(eq(schema.positions.id, ourId));
  }
}

async function getRisk(db: Db, userId: string) {
  const [r] = await db.select().from(schema.userRiskSettings).where(eq(schema.userRiskSettings.userId, userId));
  if (r) return r;
  const [created] = await db.insert(schema.userRiskSettings).values({ userId }).onConflictDoNothing().returning();
  return created ?? (await db.select().from(schema.userRiskSettings).where(eq(schema.userRiskSettings.userId, userId)))[0]!;
}

async function solSpentToday(db: Db, userId: string): Promise<bigint> {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const [r] = await db
    .select({ spent: sql<string>`coalesce(sum(-${schema.txs.solDelta}), 0)` })
    .from(schema.txs)
    .where(
      and(
        eq(schema.txs.userId, userId),
        gte(schema.txs.createdAt, start),
        inArray(schema.txs.kind, ["open", "add"]),
        inArray(schema.txs.status, ["planned", "simulated", "submitted", "confirmed"]),
      ),
    );
  return BigInt(r?.spent ?? "0");
}

/** Payload JSON (bigints as strings) → LeaderAction. */
function toAction(p: Record<string, unknown>): LeaderAction {
  const pair = (v: any) => ({ x: BigInt(v?.x ?? 0), y: BigInt(v?.y ?? 0) });
  const a = p as any;
  return { ...a, added: pair(a.added), removed: pair(a.removed), fees: pair(a.fees), removeRanges: a.removeRanges ?? [] };
}

function jsonSafe(v: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
}

export function sol(lamports: bigint): string {
  const whole = lamports / LAMPORTS_PER_SOL;
  const frac = (lamports % LAMPORTS_PER_SOL).toString().padStart(9, "0").slice(0, 4);
  return `${whole}.${frac}`;
}

function describe(label: string, a: LeaderAction, plan: Plan, dryRun: boolean, liveBlocked: boolean): string {
  const prefix = liveBlocked ? "[CANLI-ENGELLİ]" : dryRun ? "[DENEME]" : "[CANLI]";
  const where = `${a.protocol.toUpperCase()} ${a.pool?.slice(0, 6) ?? "?"}…`;
  const leaderSol = a.mintY?.startsWith("So111") ? a.added.y : a.added.x;
  const head = `${prefix} ${label}: ${a.kind}${a.strategy ? ` (${a.strategy})` : ""} ${where}`;
  switch (plan.do) {
    case "open":
      return plan.empty
        ? `${head} → boş pozisyon açardım (lider fonlamayı ayrı işlemde yapıyor)`
        : `${head} → ${sol(plan.amountSol)} SOL ile açardım (lider ${sol(leaderSol)} SOL)${plan.capped ? `, sınır: ${plan.capped}` : ""}`;
    case "add":
      return `${head} → ${sol(plan.amountSol)} SOL eklerdim (lider ${sol(leaderSol)} SOL, oran %${(Number(plan.ratioPpm) / 10_000).toFixed(2)})${plan.capped ? `, sınır: ${plan.capped}` : ""}`;
    case "remove":
      return `${head} → pozisyonun %${plan.bps / 100}'ini çekerdim`;
    case "close":
      return `${head} → pozisyonu kapatırdım`;
    case "claim":
      return `${head} → fee claim ederdim`;
    case "skip":
      return `${head} → atlandı: ${plan.reason}`;
  }
}
