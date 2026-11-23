import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { and, eq, inArray, lt } from "drizzle-orm";
import { PublicKey } from "@solana/web3.js";
import {
  DlmmTxBuilder,
  QUEUES,
  applyFlip,
  applyMove,
  createConnection,
  decide,
  distribute,
  flipParamsFrom,
  mergeBins,
  runService,
  type Bin,
  type Decision,
  type Logger,
  type ManagedPosition,
  type ManagementJob,
  type ExitRules,
  type FlipParams,
  type ManagementMode,
  readLivePosition,
  shouldCompound,
  evaluateFundProtection,
  valueInY,
  type NotificationJob,
  type PoolInfo,
  type Shape,
} from "@binflip/core";
import { createDb, schema, type Db } from "@binflip/db";

const TICK_MS = Number(process.env.MANAGER_TICK_MS ?? 30_000);

/** What we persist in positions.sim_state for dry-run positions. */
interface SimState {
  bins: Bin[];
  activeId: number;
  depositedY: number;
  claimedFeesY: number;
  peakY: number;
  entryActiveId: number;
  lastFlipActiveId: number | null;
  lowerBinId: number;
  upperBinId: number;
  flips: number;
}

/**
 * manager — runs the position-management loop (HANDOFF §3): TP / SL / trailing
 * and the flip modes, on every open position, every MANAGER_TICK_MS.
 *
 * Dry-run: each position is a virtual bin-level model fed by the REAL pool
 * price, so flips and exits happen exactly when they would live.
 * Live: decisions are computed from on-chain bins and queued for the executor,
 * which re-checks them on chain before acting (one action per position per bin).
 */
await runService("manager", async ({ config, log }) => {
  const { db, ping, close } = createDb(config.DATABASE_URL, { max: 3 });
  const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  const notifications = new Queue<NotificationJob>(QUEUES.NOTIFICATIONS, { connection });
  const management = new Queue<ManagementJob>(QUEUES.MANAGEMENT, { connection });
  // Read-only: the owner key is irrelevant for price/position reads.
  const builder = new DlmmTxBuilder(createConnection(config.SOLANA_RPC_URL), PublicKey.default);
  const dryRun = config.mode === "dry_run";

  let running = false;
  let ticks = 0;
  const notifyFn = (userId: string, text: string) => notifications.add("notify", { userId, text }, { removeOnComplete: 1000 }).then(() => undefined);
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      // Live only: find positions the user opened themselves in the bot wallet (~every 5 min).
      if (!dryRun && ticks++ % Math.max(1, Math.round(300_000 / TICK_MS)) === 0) {
        await discoverManual(db, builder, log, notifyFn).catch((err) => log.warn({ err: (err as Error).message }, "discovery failed"));
      }
      await manageAll(
        db,
        builder,
        dryRun,
        log,
        notifyFn,
        management,
        BigInt(config.COMPOUND_MIN_LAMPORTS),
      );
    } catch (err) {
      log.error({ err: (err as Error).message }, "tick failed");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), TICK_MS);
  void tick();

  await ping();
  return {
    checks: { postgres: ping, redis: async () => void (await connection.ping()) },
    cleanups: [() => clearInterval(timer), () => close(), async () => void (await connection.quit()), () => notifications.close(), () => management.close()],
  };
});

async function manageAll(
  db: Db,
  builder: DlmmTxBuilder,
  dryRun: boolean,
  log: Logger,
  notify: (userId: string, text: string) => Promise<void>,
  management: Queue<ManagementJob>,
  compoundMin: bigint,
) {
  if (dryRun) {
    // LP Agent: an empty copy whose funding never came is closed after ~1 minute.
    const stale = await db
      .update(schema.positions)
      .set({ state: "CLOSED", closedAt: new Date(), closeReason: "unfunded_empty" })
      .where(and(eq(schema.positions.state, "OPENING"), eq(schema.positions.dryRun, true), eq(schema.positions.depositedSol, 0n), lt(schema.positions.openedAt, new Date(Date.now() - 60_000))))
      .returning({ id: schema.positions.id, userId: schema.positions.userId });
    for (const p of stale) await notify(p.userId, "[DENEME] Fonlama gelmedi: boş kopya 1 dk sonra kapatılırdı (rent geri alınır).");
  }

  const rows = await db
    .select()
    .from(schema.positions)
    .leftJoin(schema.copySettings, eq(schema.copySettings.leaderId, schema.positions.leaderId))
    .leftJoin(schema.leaders, eq(schema.leaders.id, schema.positions.leaderId))
    .where(and(eq(schema.positions.state, "ACTIVE"), eq(schema.positions.dryRun, dryRun), inArray(schema.positions.protocol, ["dlmm"])));
  if (!rows.length) return;

  const pools = new Map<string, PoolInfo>();
  for (const pool of new Set(rows.map((r) => r.positions.pool))) {
    try {
      pools.set(pool, await builder.poolInfo(pool));
    } catch (err) {
      log.warn({ pool, err: (err as Error).message }, "pool read failed");
    }
  }

  const manual = new Map((await db.select().from(schema.manualSettings)).map((m) => [m.userId, m]));
  const tripped = await fundProtectionTick(db, builder, dryRun, log, notify);

  for (const { positions: pos, copy_settings: copySet, leaders: leader } of rows) {
    const info = pools.get(pos.pool);
    if (!info || !info.solIsY) continue; // stage 4 models SOL-as-Y pools (all of Karınca's so far)
    // Copies use their leader's settings; positions the user opened use manual_settings.
    const m = pos.leaderId ? null : manual.get(pos.userId);
    if (!pos.leaderId && m && !m.enabled) continue;
    const cs = copySet ?? (m ? { ...m } : null);
    const mode = cs?.managementMode ?? pos.managementMode;
    // LP Agent: TP/SL saved on the copy at open win over today's settings.
    const exits = pos.exitRulesSaved
      ? { takeProfitBps: pos.takeProfitBps, stopLossBps: pos.stopLossBps, trailingStopBps: pos.trailingStopBps }
      : { takeProfitBps: cs?.takeProfitBps ?? null, stopLossBps: cs?.stopLossBps ?? null, trailingStopBps: cs?.trailingStopBps ?? null };
    const flip = flipParamsFrom(cs?.managementParams);
    const label = leader?.label ?? "manuel";

    if (!dryRun) {
      await manageLive(db, builder, pos, mode, exits, flip, management, log, cs?.compoundIntervalMinutes ?? null, compoundMin, tripped.has(pos.userId));
      continue;
    }

    let sim = (pos.simState as SimState | null) ?? initSim(pos, info);
    // Mirror adds the executor recorded since the last tick into the model.
    const deposited = Number(pos.depositedSol);
    if (deposited > sim.depositedY) {
      const delta = deposited - sim.depositedY;
      const top = Math.min(sim.upperBinId, info.activeBinId);
      sim = { ...sim, depositedY: deposited, bins: mergeBins(sim.bins, distribute(delta, sim.lowerBinId, top, shapeOf(pos.strategy), "y", top)) };
    }
    sim = { ...sim, bins: applyMove(sim.bins, sim.activeId, info.activeBinId, info.binStep), activeId: info.activeBinId };

    const state: ManagedPosition = { ...sim, binStep: info.binStep };
    const d = decide(state, mode, exits, flip);
    sim.peakY = Math.max(sim.peakY, d.valueY);

    if (d.do === "flip" && tripped.has(pos.userId)) {
      // LP Agent: once the loss limit is hit, only exits keep running.
    } else if (d.do === "flip") {
      const next = applyFlip(state, d);
      sim = { ...sim, bins: next.bins, lastFlipActiveId: next.lastFlipActiveId, lowerBinId: next.lowerBinId, upperBinId: next.upperBinId, flips: sim.flips + 1 };
      await record(db, pos, `flip_${pos.id}_${info.activeBinId}`, "flip", d);
      await notify(pos.userId, describeFlip(label, pos.pool, d, flip.thresholdBps));
      log.info({ position: pos.id, kind: d.kind, dropBps: d.dropBps }, "flip (dry-run)");
    }

    if (d.do === "close") {
      await db
        .update(schema.positions)
        .set({ state: "CLOSED", closedAt: new Date(), closeReason: d.reason, simState: sim as never, currentValueSol: String(d.valueY / 1e9), lastManagedAt: new Date() })
        .where(eq(schema.positions.id, pos.id));
      await record(db, pos, `close_${pos.id}`, "close", d);
      await notify(pos.userId, `[DENEME] ${label}: ${reasonTr(d.reason)} → pozisyonu kapatırdım (PnL %${(d.pnlBps / 100).toFixed(2)}, ${(d.valueY / 1e9).toFixed(4)} SOL)`);
      log.info({ position: pos.id, reason: d.reason, pnlBps: d.pnlBps }, "close (dry-run)");
      continue;
    }

    await db
      .update(schema.positions)
      .set({ simState: sim as never, peakValue: String(sim.peakY / 1e9), currentValueSol: String(d.valueY / 1e9), lastManagedAt: new Date() })
      .where(eq(schema.positions.id, pos.id));
    await snapshot(db, pos, d.valueY);
  }
}

/** One pnl_snapshots row per position every ~5 minutes (for the Analysis chart). */
const lastSnap = new Map<string, number>();
async function snapshot(db: Db, pos: typeof schema.positions.$inferSelect, valueY: number) {
  const now = Date.now();
  if (now - (lastSnap.get(pos.id) ?? 0) < 5 * 60_000) return;
  lastSnap.set(pos.id, now);
  await db.insert(schema.pnlSnapshots).values({ userId: pos.userId, positionId: pos.id, valueSol: BigInt(Math.round(valueY)), activeBinId: null });
}

function initSim(pos: typeof schema.positions.$inferSelect, info: PoolInfo): SimState {
  const entry = pos.entryActiveBinId ?? info.activeBinId;
  const lower = pos.lowerBinId ?? entry - 68;
  const upper = pos.upperBinId ?? entry;
  const top = Math.min(upper, entry);
  const deposited = Number(pos.depositedSol);
  return {
    bins: distribute(deposited, lower, top, shapeOf(pos.strategy), "y", top),
    activeId: entry,
    depositedY: deposited,
    claimedFeesY: 0,
    peakY: deposited,
    entryActiveId: entry,
    lastFlipActiveId: null,
    lowerBinId: lower,
    upperBinId: upper,
    flips: 0,
  };
}

async function record(db: Db, pos: typeof schema.positions.$inferSelect, key: string, kind: "flip" | "close", d: Decision) {
  await db
    .insert(schema.txs)
    .values({
      userId: pos.userId,
      positionId: pos.id,
      idempotencyKey: key,
      kind,
      status: "planned",
      dryRun: pos.dryRun,
      reason: d.do === "close" ? d.reason : d.do === "flip" ? `${d.kind}_flip` : null,
      plan: JSON.parse(JSON.stringify(d)),
    })
    .onConflictDoNothing();
}

const shapeOf = (s: string | null): Shape => (s === "spot" || s === "curve" || s === "bid_ask" ? s : "spot");

const reasonTr = (r: string) => ({ take_profit: "TP", stop_loss: "SL", trailing_stop: "trailing stop" })[r] ?? r;

function describeFlip(label: string, pool: string, d: Extract<Decision, { do: "flip" }>, thresholdBps: number) {
  const kind = d.kind === "staged" ? `kademeli flip (eşik %${thresholdBps / 100})` : "dipte flip";
  return `[DENEME] ${label}: ${kind} ${pool.slice(0, 6)}… → fiyat %${(-d.dropBps / 100).toFixed(1)} düştü; ${d.withdraw.from}..${d.withdraw.to} bin'lerindeki token çekilip ${d.ask.from}..${d.ask.to} aralığına (fiyatın üstü, ${d.ask.shape}) konurdu. Aşağıdaki SOL bin'lerine dokunulmaz. PnL %${(d.pnlBps / 100).toFixed(2)}`;
}

async function manageLive(
  db: Db,
  builder: DlmmTxBuilder,
  pos: typeof schema.positions.$inferSelect,
  mode: ManagementMode,
  exits: ExitRules,
  flip: FlipParams,
  management: Queue<ManagementJob>,
  log: Logger,
  compoundMinutes: number | null,
  compoundMin: bigint,
  fundProtectionTripped = false,
) {
  if (!pos.ourPosition) return;
  const { state, activeId, binStep, feeX, feeY } = await readLivePosition(builder, pos);
  const d = decide(state, mode, exits, flip);
  const peak = Math.max(state.peakY, d.valueY);
  await db
    .update(schema.positions)
    .set({ peakValue: String(peak / 1e9), currentValueSol: String(d.valueY / 1e9), lastManagedAt: new Date() })
    .where(eq(schema.positions.id, pos.id));
  await snapshot(db, pos, d.valueY);
  // Loss limit hit: exits only (no flips, no compounds), like LP Agent.
  if (fundProtectionTripped && d.do !== "close") return;
  if (d.do === "hold") {
    const c = shouldCompound({ feeX, feeY, activeId, binStep, lastCompoundAt: pos.lastCompoundAt, openedAt: pos.openedAt, intervalMinutes: compoundMinutes, minLamports: compoundMin });
    if (c.do === "compound") {
      const slot = Math.floor(Date.now() / (compoundMinutes! * 60_000));
      await management.add("manage", { positionId: pos.id, kind: "compound", reason: "auto_compound", activeId }, { jobId: `mgmt_${pos.id}_compound_${slot}`, attempts: 2, backoff: { type: "exponential", delay: 5_000 }, removeOnComplete: { age: 86_400 } });
      log.info({ position: pos.id, feesSol: Number(c.feesValueY) / 1e9 }, "compound queued");
    }
    return;
  }
  const kind = d.do;
  const reason = d.do === "close" ? d.reason : `${d.kind}_flip`;
  await management.add(
    "manage",
    { positionId: pos.id, kind, reason, activeId },
    // One action per position per active bin; exits are retried, flips re-decided next tick.
    { jobId: `mgmt_${pos.id}_${kind}_${activeId}`, attempts: kind === "close" ? 5 : 2, backoff: { type: "exponential", delay: 5_000 }, removeOnComplete: { age: 86_400 } },
  );
  log.info({ position: pos.id, kind, reason, activeId, pnlBps: d.pnlBps }, "live decision queued");
}

/**
 * Adopt positions in the bot wallet that we did not open (the user opened them
 * in Phantom), and close our records of positions that vanished on chain.
 * PnL of an adopted position is measured from its value at adoption.
 */
async function discoverManual(db: Db, builder: DlmmTxBuilder, log: Logger, notify: (userId: string, text: string) => Promise<void>) {
  const wallets = await db.select().from(schema.agentWallets);
  for (const w of wallets) {
    const onChain = await builder.listPositions(new PublicKey(w.publicKey));
    const known = await db.select().from(schema.positions).where(and(eq(schema.positions.userId, w.userId), eq(schema.positions.dryRun, false)));
    const byAddress = new Map(known.filter((k) => k.ourPosition).map((k) => [k.ourPosition!, k]));
    const live = new Set(onChain.map((p) => p.position));

    // Closed from outside (e.g. the user closed it in Phantom).
    for (const k of known) {
      if (k.state === "ACTIVE" && k.ourPosition && !live.has(k.ourPosition)) {
        await db.update(schema.positions).set({ state: "CLOSED", closedAt: new Date(), closeReason: "closed_externally" }).where(eq(schema.positions.id, k.id));
        log.info({ position: k.ourPosition }, "position closed outside the bot");
      }
    }

    const [m] = await db.select().from(schema.manualSettings).where(eq(schema.manualSettings.userId, w.userId));
    if (m && !m.enabled) continue;
    for (const p of onChain) {
      if (byAddress.has(p.position)) continue;
      const info = await builder.poolInfo(p.pool);
      if (!info.solIsY) continue;
      const pb = await builder.positionBins(p.pool, p.position);
      const value = valueInY(pb.bins, info.activeBinId, info.binStep);
      const [row] = await db
        .insert(schema.positions)
        .values({
          userId: w.userId,
          leaderId: null,
          agentWalletId: w.id,
          protocol: "dlmm",
          pool: p.pool,
          ourPosition: p.position,
          state: "ACTIVE",
          dryRun: false,
          managementMode: m?.managementMode ?? "staged_flip",
          lowerBinId: p.lower,
          upperBinId: p.upper,
          entryActiveBinId: info.activeBinId,
          depositedSol: BigInt(Math.round(value)),
          fundedAt: new Date(),
          openedAt: new Date(),
          peakValue: String(value / 1e9),
          takeProfitBps: m?.takeProfitBps ?? null,
          stopLossBps: m?.stopLossBps ?? null,
          trailingStopBps: m?.trailingStopBps ?? null,
          exitRulesSaved: true,
        })
        .onConflictDoNothing()
        .returning({ id: schema.positions.id });
      if (!row) continue;
      log.info({ position: p.position, pool: p.pool, valueSol: value / 1e9 }, "manual position adopted");
      await notify(w.userId, `🧭 Bot cüzdanında yeni pozisyon bulundu ve yönetime alındı: ${p.pool.slice(0, 6)}… (${(value / 1e9).toFixed(4)} SOL, mod ${m?.managementMode ?? "staged_flip"}). PnL bu değerden ölçülecek.`);
    }
  }
}

/**
 * Fund protection (LP Agent): realized PnL of copies closed since the count
 * started, measured from its peak. Trips → new opens/adds/compounds/rebalances
 * and flips stop; exits keep following leaders. Returns the users tripped now.
 */
async function fundProtectionTick(
  db: Db,
  builder: DlmmTxBuilder,
  dryRun: boolean,
  log: Logger,
  notify: (userId: string, text: string) => Promise<void>,
): Promise<Set<string>> {
  const tripped = new Set<string>();
  const risks = await db.select().from(schema.userRiskSettings).where(eq(schema.userRiskSettings.fundProtectionEnabled, true));
  for (const r of risks) {
    if (r.fundProtectionTrippedAt) {
      tripped.add(r.userId);
      continue;
    }
    const since = r.fundProtectionSince ?? new Date();
    if (!r.fundProtectionSince) await db.update(schema.userRiskSettings).set({ fundProtectionSince: since }).where(eq(schema.userRiskSettings.userId, r.userId));
    const mine = await db.select().from(schema.positions).where(and(eq(schema.positions.userId, r.userId), eq(schema.positions.dryRun, dryRun)));
    const realized = mine
      .filter((p) => p.state === "CLOSED" && p.leaderId && p.closedAt && p.closedAt >= since && p.currentValueSol !== null)
      .reduce((s, p) => s + BigInt(Math.round(Number(p.currentValueSol) * 1e9)) - p.depositedSol, 0n);
    let netWorth = mine.filter((p) => p.state === "ACTIVE" && p.currentValueSol !== null).reduce((s, p) => s + BigInt(Math.round(Number(p.currentValueSol) * 1e9)), 0n);
    if (!dryRun) {
      const [w] = await db.select().from(schema.agentWallets).where(eq(schema.agentWallets.userId, r.userId));
      if (w) netWorth += BigInt(await builder.connection.getBalance(new PublicKey(w.publicKey)).catch(() => 0));
    }
    if (r.fundProtectionLossSol === null && netWorth === 0n) continue; // nothing to size the limit from yet
    const st = evaluateFundProtection({
      realizedLamports: realized,
      peakLamports: r.fundProtectionPeakLamports,
      limitLamports: r.fundProtectionLossSol,
      lossBps: r.fundProtectionLossBps,
      netWorthLamports: netWorth,
    });
    await db
      .update(schema.userRiskSettings)
      .set({
        fundProtectionPeakLamports: st.peakLamports,
        fundProtectionLossSol: st.limitLamports,
        ...(st.tripped ? { fundProtectionTrippedAt: new Date() } : {}),
      })
      .where(eq(schema.userRiskSettings.userId, r.userId));
    if (st.tripped) {
      tripped.add(r.userId);
      log.warn({ userId: r.userId, drawdownSol: Number(st.drawdownLamports) / 1e9 }, "fund protection tripped");
      await notify(r.userId, `🛑 Zarar limiti doldu: kapanan kopyalardaki kayıp zirveden ${(Number(st.drawdownLamports) / 1e9).toFixed(4)} SOL (limit ${(Number(st.limitLamports) / 1e9).toFixed(4)} SOL). Yeni açma/ekleme/compound/flip durdu, çıkışlar liderleri takip ediyor. Panelden "Devam et" ile yeniden başlatabilirsiniz.`);
    }
  }
  return tripped;
}
