import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { and, eq, inArray } from "drizzle-orm";
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
 * Live: decisions are computed from on-chain bins; execution goes through the
 * executor (next step), so for now live decisions are logged only.
 */
await runService("manager", async ({ config, log }) => {
  const { db, ping, close } = createDb(config.DATABASE_URL, { max: 3 });
  const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  const notifications = new Queue<NotificationJob>(QUEUES.NOTIFICATIONS, { connection });
  // Read-only: the owner key is irrelevant for price/position reads.
  const builder = new DlmmTxBuilder(createConnection(config.SOLANA_RPC_URL), PublicKey.default);
  const dryRun = config.mode === "dry_run";
  if (!dryRun) log.warn("live position management: decisions are logged, execution lands in the next step");

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await manageAll(db, builder, dryRun, log, (userId, text) =>
        notifications.add("notify", { userId, text }, { removeOnComplete: 1000 }).then(() => undefined),
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
    cleanups: [() => clearInterval(timer), () => close(), async () => void (await connection.quit()), () => notifications.close()],
  };
});

async function manageAll(
  db: Db,
  builder: DlmmTxBuilder,
  dryRun: boolean,
  log: Logger,
  notify: (userId: string, text: string) => Promise<void>,
) {
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

  for (const { positions: pos, copy_settings: cs, leaders: leader } of rows) {
    const info = pools.get(pos.pool);
    if (!info || !info.solIsY) continue; // stage 4 models SOL-as-Y pools (all of Karınca's so far)
    const mode = cs?.managementMode ?? pos.managementMode;
    const exits = {
      takeProfitBps: cs?.takeProfitBps ?? null,
      stopLossBps: cs?.stopLossBps ?? null,
      trailingStopBps: cs?.trailingStopBps ?? null,
    };
    const flip = flipParamsFrom(cs?.managementParams);
    const label = leader?.label ?? "manuel";

    if (!dryRun) continue; // live: see header comment

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

    if (d.do === "flip") {
      const next = applyFlip(state, d);
      sim = { ...sim, bins: next.bins, lastFlipActiveId: next.lastFlipActiveId, lowerBinId: next.lowerBinId, upperBinId: next.upperBinId, flips: sim.flips + 1 };
      await record(db, pos, `flip_${pos.id}_${info.activeBinId}`, "flip", d);
      await notify(pos.userId, describeFlip(label, pos.pool, d, flip.thresholdBps));
      log.info({ position: pos.id, kind: d.kind, dropBps: d.dropBps }, "flip (dry-run)");
    }

    if (d.do === "close") {
      await db
        .update(schema.positions)
        .set({ state: "CLOSED", closedAt: new Date(), closeReason: d.reason, simState: sim as never, lastManagedAt: new Date() })
        .where(eq(schema.positions.id, pos.id));
      await record(db, pos, `close_${pos.id}`, "close", d);
      await notify(pos.userId, `[DENEME] ${label}: ${reasonTr(d.reason)} → pozisyonu kapatırdım (PnL %${(d.pnlBps / 100).toFixed(2)}, ${(d.valueY / 1e9).toFixed(4)} SOL)`);
      log.info({ position: pos.id, reason: d.reason, pnlBps: d.pnlBps }, "close (dry-run)");
      continue;
    }

    await db
      .update(schema.positions)
      .set({ simState: sim as never, peakValue: String(sim.peakY / 1e9), lastManagedAt: new Date() })
      .where(eq(schema.positions.id, pos.id));
  }
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
