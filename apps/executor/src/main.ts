import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { PublicKey } from "@solana/web3.js";
import {
  DlmmTxBuilder,
  KeystoreSigner,
  LAMPORTS_PER_SOL,
  QUEUES,
  TxSender,
  createConnection,
  planCopy,
  readPassphraseFile,
  runService,
  type BuiltTxs,
  type Config,
  type ExecutionJob,
  type LeaderAction,
  type Logger,
  type NotificationJob,
  type Plan,
  type Strategy,
} from "@binflip/core";
import { createDb, schema, type Db } from "@binflip/db";

type PositionRow = typeof schema.positions.$inferSelect;
type EventRow = typeof schema.leaderEvents.$inferSelect;

interface Live {
  builder: DlmmTxBuilder;
  sender: TxSender;
  agentWalletId: string;
  publicKey: string;
}

/**
 * executor — turns stored leader events into our actions.
 *
 * Every event gets exactly one txs row (idempotency key event_<id>):
 *   dry-run: planned (and the position mirror is updated right away)
 *   live:    planned → submitted (signature stored BEFORE broadcast) → confirmed | failed
 * A job that finds its row already "submitted" never re-sends: it marks the
 * row for review, so a crash can't double-spend.
 */
await runService("executor", async ({ config, log }) => {
  const { db, ping, close } = createDb(config.DATABASE_URL, { max: 5 });
  const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  const notifications = new Queue<NotificationJob>(QUEUES.NOTIFICATIONS, { connection });
  const live = config.mode === "live" ? await setupLive(db, config, log) : null;

  const worker = new Worker<ExecutionJob>(
    QUEUES.EXECUTION,
    async (job) => {
      const r = await handleEvent(db, job.data.leaderEventId, config, live, log);
      if (!r) return { duplicate: true };
      log.info({ leader: r.leaderLabel, kind: r.kind, outcome: r.outcome }, r.text);
      await notifications.add("notify", { userId: r.userId, text: r.text }, { removeOnComplete: 1000 });
      return { outcome: r.outcome };
    },
    // Serial: positions, balances and daily limits must not race.
    { connection, concurrency: 1 },
  );
  worker.on("failed", (job, err) => log.error({ event: job?.data.leaderEventId, err: err.message }, "event failed"));

  await ping();
  return {
    checks: {
      postgres: ping,
      redis: async () => void (await connection.ping()),
      ...(live ? { rpc: async () => void (await live.builder.connection.getSlot()) } : {}),
    },
    cleanups: [() => close(), async () => void (await connection.quit()), () => notifications.close(), () => worker.close()],
  };
});

async function setupLive(db: Db, config: Config, log: Logger): Promise<Live> {
  const signer = KeystoreSigner.fromFile(config.KEYSTORE_PATH!, readPassphraseFile(config.KEYSTORE_PASSPHRASE_FILE!));
  const [wallet] = await db.select().from(schema.agentWallets).where(eq(schema.agentWallets.publicKey, signer.publicKey));
  if (!wallet) throw new Error(`agent wallet ${signer.publicKey} is not registered (run wallet:create)`);
  const conn = createConnection(config.SOLANA_RPC_URL, config.SOLANA_WS_URL);
  const balance = await conn.getBalance(new PublicKey(signer.publicKey));
  log.warn({ agent: signer.publicKey, balanceSol: balance / 1e9 }, "LIVE: agent wallet loaded");
  return {
    builder: new DlmmTxBuilder(conn, new PublicKey(signer.publicKey)),
    sender: new TxSender(conn, signer),
    agentWalletId: wallet.id,
    publicKey: signer.publicKey,
  };
}

async function handleEvent(db: Db, eventId: string, config: Config, live: Live | null, log: Logger) {
  const [row] = await db
    .select()
    .from(schema.leaderEvents)
    .innerJoin(schema.leaders, eq(schema.leaders.id, schema.leaderEvents.leaderId))
    .innerJoin(schema.copySettings, eq(schema.copySettings.leaderId, schema.leaders.id))
    .where(eq(schema.leaderEvents.id, eventId));
  if (!row) throw new Error(`leader event ${eventId} or its copy settings not found`);
  const { leader_events: ev, leaders: leader, copy_settings: cs } = row;
  const idempotencyKey = `event_${ev.id}`;

  // A previous attempt already got this far: never act twice.
  const [existing] = await db
    .select()
    .from(schema.txs)
    .where(and(eq(schema.txs.userId, ev.userId), eq(schema.txs.idempotencyKey, idempotencyKey)));
  if (existing) {
    if (existing.status === "submitted" || (existing.status === "planned" && !existing.dryRun)) {
      await db
        .update(schema.txs)
        .set({ status: "failed", reason: "interrupted_needs_review" })
        .where(eq(schema.txs.id, existing.id));
      return {
        userId: ev.userId,
        leaderLabel: leader.label,
        kind: existing.kind,
        outcome: "needs_review",
        text: `⚠️ ${leader.label}: önceki deneme yarıda kaldı (${existing.kind}). Tekrar gönderilmedi, elle kontrol edin. İmzalar: ${JSON.stringify((existing.plan as any).signatures ?? [])}`,
      };
    }
    return null;
  }

  const risk = await getRisk(db, ev.userId);
  const action = toAction(ev.payload);
  const ours = ev.leaderPosition
    ? ((
        await db
          .select()
          .from(schema.positions)
          .where(and(eq(schema.positions.userId, ev.userId), eq(schema.positions.leaderPosition, ev.leaderPosition)))
      )[0] ?? null)
    : null;

  let plan = planCopy(
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
      dailyRoom: risk.maxSolPerDay - (await solSpentToday(db, ev.userId)),
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

  // Live-only guards that need chain state.
  if (live && plan.do !== "skip") {
    if (action.protocol !== "dlmm") plan = { do: "skip", kind: action.kind, reason: "damm_live_not_supported" };
    else if (plan.do !== "open" && !ours?.ourPosition) plan = { do: "skip", kind: action.kind, reason: "position_not_copied" };
    // Every open pays position rent, even an empty one, so it needs the reserve too.
    else if (plan.do === "open" || (plan.do === "add" && plan.amountSol > 0n)) {
      const bal = BigInt(await live.builder.connection.getBalance(new PublicKey(live.publicKey)));
      if (bal < plan.amountSol + BigInt(config.SOL_RESERVE_LAMPORTS)) {
        plan = { do: "skip", kind: action.kind, reason: "low_balance" };
      }
    }
  }

  const dryRun = config.mode === "dry_run";
  const [t] = await db
    .insert(schema.txs)
    .values({
      userId: ev.userId,
      positionId: ours?.id ?? null,
      leaderEventId: ev.id,
      idempotencyKey,
      kind: plan.do === "skip" ? action.kind : plan.do,
      status: plan.do === "skip" ? "skipped" : "planned",
      reason: plan.do === "skip" ? plan.reason : null,
      dryRun,
      solDelta: "amountSol" in plan ? -plan.amountSol : null,
      plan: jsonSafe({ plan, action: { kind: action.kind, strategy: action.strategy, bins: [action.lowerBinId, action.upperBinId] } }),
    })
    .onConflictDoNothing()
    .returning({ id: schema.txs.id });
  if (!t) return null;
  await db.update(schema.leaderEvents).set({ processedAt: new Date() }).where(eq(schema.leaderEvents.id, ev.id));

  const base = { userId: ev.userId, leaderLabel: leader.label, kind: action.kind };
  if (plan.do === "skip") return { ...base, outcome: "skipped", text: describe(leader.label, action, plan, dryRun) };

  if (dryRun) {
    await applyToPositions(db, plan, action, ev, cs.managementMode, ours, true, t.id, null);
    return { ...base, outcome: "planned", text: describe(leader.label, action, plan, true) };
  }

  // ── LIVE ──────────────────────────────────────────────────────────────
  const l = live!;
  const signatures: string[] = [];
  const saveSig = async (sig: string) => {
    signatures.push(sig);
    await db
      .update(schema.txs)
      .set({ status: "submitted", signature: sig, attempts: sql`${schema.txs.attempts} + 1`, plan: sql`jsonb_set(${schema.txs.plan}, '{signatures}', ${JSON.stringify(signatures)}::jsonb)` })
      .where(eq(schema.txs.id, t.id));
  };
  try {
    const ourPosition = await executeLive(l, plan, action, ours, saveSig, config, log);
    const fees = await totalFees(l, signatures);
    await db
      .update(schema.txs)
      .set({ status: "confirmed", feeLamports: BigInt(fees) })
      .where(eq(schema.txs.id, t.id));
    await applyToPositions(db, plan, action, ev, cs.managementMode, ours, false, t.id, ourPosition, l.agentWalletId);
    return {
      ...base,
      outcome: "confirmed",
      text: `${describe(leader.label, action, plan, false)} ✅ ${signatures.length} işlem, ücret ${sol(BigInt(fees))} SOL`,
    };
  } catch (err) {
    const msg = (err as Error).message;
    await db
      .update(schema.txs)
      .set({ status: "failed", error: msg.slice(0, 2000), reason: signatures.length ? "partial_needs_review" : "send_failed" })
      .where(eq(schema.txs.id, t.id));
    log.error({ err: msg, signatures }, "live execution failed");
    return {
      ...base,
      outcome: "failed",
      text: `❌ ${leader.label}: ${plan.do} başarısız: ${msg.slice(0, 200)}${signatures.length ? ` (gönderilen: ${signatures.length} işlem, kontrol edin)` : ""}`,
    };
  }
}

/** Build and send the plan. Returns our position address (for opens). */
async function executeLive(
  l: Live,
  plan: Plan,
  a: LeaderAction,
  ours: PositionRow | null,
  onSignature: (sig: string) => Promise<void>,
  config: Config,
  log: Logger,
): Promise<string | null> {
  const opts = { priorityMicroLamports: config.PRIORITY_FEE_MICROLAMPORTS, onSignature };
  const sendAll = async (built: BuiltTxs) => {
    for (const [i, tx] of built.txs.entries()) {
      const r = await l.sender.send(tx, built.extraSigners.get(i) ?? [], opts);
      log.info({ sig: r.signature, step: `${i + 1}/${built.txs.length}`, fee: r.feeLamports }, "confirmed");
    }
    return built.position;
  };
  const pool = a.pool!;
  const slippagePct = 1;

  switch (plan.do) {
    case "open": {
      if (a.lowerBinId === null || a.upperBinId === null) throw new Error("leader range unknown");
      const built = await l.builder.open({
        pool,
        lowerBinId: a.lowerBinId,
        upperBinId: a.upperBinId,
        amountSol: plan.amountSol,
        strategy: a.strategy,
        slippagePct,
      });
      const position = await sendAll(built);
      // Wide or empty opens create the position first; fund it now if needed.
      const width = a.upperBinId - a.lowerBinId + 1;
      if (plan.amountSol > 0n && (width > 70 || built.txs.length === 1) && !(await hasLiquidity(l, pool, position!))) {
        await sendAll(
          await l.builder.add({ pool, position: position!, lowerBinId: a.lowerBinId, upperBinId: a.upperBinId, amountSol: plan.amountSol, strategy: a.strategy, slippagePct }),
        );
      }
      return position;
    }
    case "add":
      return sendAll(
        await l.builder.add({
          pool,
          position: ours!.ourPosition!,
          lowerBinId: ours!.lowerBinId ?? a.lowerBinId!,
          upperBinId: ours!.upperBinId ?? a.upperBinId!,
          amountSol: plan.amountSol,
          strategy: a.strategy ?? ours!.strategy,
          slippagePct,
        }),
      );
    case "remove":
      return sendAll(await l.builder.remove({ pool, position: ours!.ourPosition!, bps: plan.bps, close: false }));
    case "close":
      return sendAll(await l.builder.remove({ pool, position: ours!.ourPosition!, bps: 10_000, close: true }));
    case "claim":
      return sendAll(await l.builder.claim({ pool, position: ours!.ourPosition! }));
    case "skip":
      return null;
  }
}

async function hasLiquidity(l: Live, pool: string, position: string) {
  const p = await l.builder.position(pool, position);
  return p.positionData.positionBinData.some((b) => b.positionLiquidity !== "0");
}

async function totalFees(l: Live, sigs: string[]): Promise<number> {
  let fee = 0;
  for (const s of sigs) {
    const t = await l.builder.connection
      .getTransaction(s, { commitment: "confirmed", maxSupportedTransactionVersion: 0 })
      .catch(() => null);
    fee += t?.meta?.fee ?? 0;
  }
  return fee;
}

/** Mirror the plan onto our positions table. Live: only after confirmation. */
async function applyToPositions(
  db: Db,
  plan: Plan,
  a: LeaderAction,
  ev: EventRow,
  mgmt: (typeof schema.managementMode.enumValues)[number],
  ours: PositionRow | null,
  dryRun: boolean,
  txId: string,
  ourPosition: string | null,
  agentWalletId?: string,
) {
  const now = new Date();
  if (plan.do === "open") {
    const [p] = await db
      .insert(schema.positions)
      .values({
        userId: ev.userId,
        leaderId: ev.leaderId,
        agentWalletId: agentWalletId ?? null,
        protocol: a.protocol,
        pool: a.pool ?? "unknown",
        leaderPosition: a.position,
        ourPosition,
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
  if (!ours) return;
  if (plan.do === "add") {
    await db
      .update(schema.positions)
      .set({
        state: "ACTIVE",
        depositedSol: sql`${schema.positions.depositedSol} + ${plan.amountSol}`,
        ...(plan.firstFunding
          ? { sizeRatioPpm: plan.ratioPpm, fundedAt: now, strategy: a.strategy, entryActiveBinId: a.activeBinId }
          : {}),
        ...(dryRun && a.lowerBinId !== null ? { lowerBinId: a.lowerBinId, upperBinId: a.upperBinId } : {}),
      })
      .where(eq(schema.positions.id, ours.id));
  } else if (plan.do === "close") {
    await db
      .update(schema.positions)
      .set({ state: "CLOSED", closedAt: now, closeReason: "leader_exit" })
      .where(eq(schema.positions.id, ours.id));
  }
}

async function getRisk(db: Db, userId: string) {
  const [r] = await db.select().from(schema.userRiskSettings).where(eq(schema.userRiskSettings.userId, userId));
  if (r) return r;
  await db.insert(schema.userRiskSettings).values({ userId }).onConflictDoNothing();
  return (await db.select().from(schema.userRiskSettings).where(eq(schema.userRiskSettings.userId, userId)))[0]!;
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

function sol(lamports: bigint): string {
  const whole = lamports / LAMPORTS_PER_SOL;
  const frac = (lamports % LAMPORTS_PER_SOL).toString().padStart(9, "0").slice(0, 4);
  return `${whole}.${frac}`;
}

function describe(label: string, a: LeaderAction, plan: Plan, dryRun: boolean): string {
  const prefix = dryRun ? "[DENEME]" : "[CANLI]";
  const verb = (would: string, did: string) => (dryRun ? would : did);
  const where = `${a.protocol.toUpperCase()} ${a.pool?.slice(0, 6) ?? "?"}…`;
  const leaderSol = a.mintY?.startsWith("So111") ? a.added.y : a.added.x;
  const head = `${prefix} ${label}: ${a.kind}${a.strategy ? ` (${a.strategy})` : ""} ${where}`;
  switch (plan.do) {
    case "open":
      return plan.empty
        ? `${head} → boş pozisyon ${verb("açardım", "açıldı")} (lider fonlamayı ayrı işlemde yapıyor)`
        : `${head} → ${sol(plan.amountSol)} SOL ile ${verb("açardım", "açıldı")} (lider ${sol(leaderSol)} SOL)${plan.capped ? `, sınır: ${plan.capped}` : ""}`;
    case "add":
      return `${head} → ${sol(plan.amountSol)} SOL ${verb("eklerdim", "eklendi")} (lider ${sol(leaderSol)} SOL, oran %${(Number(plan.ratioPpm) / 10_000).toFixed(2)})${plan.capped ? `, sınır: ${plan.capped}` : ""}`;
    case "remove":
      return `${head} → pozisyonun %${plan.bps / 100}'i ${verb("çekilirdi", "çekildi")}`;
    case "close":
      return `${head} → pozisyon ${verb("kapatılırdı", "kapatıldı")}`;
    case "claim":
      return `${head} → fee ${verb("claim edilirdi", "claim edildi")}`;
    case "skip":
      return `${head} → atlandı: ${plan.reason}`;
  }
}
