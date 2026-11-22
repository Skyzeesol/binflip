import { Worker, type Job, type Queue } from "bullmq";
import type { Redis } from "ioredis";
import { and, eq } from "drizzle-orm";
import {
  QUEUES,
  WSOL_MINT,
  decide,
  flipParamsFrom,
  readLivePosition,
  type BuiltTxs,
  type Config,
  type DlmmTxBuilder,
  type ExitRules,
  type Logger,
  type ManagementJob,
  type NotificationJob,
  type TxSender,
} from "@binflip/core";
import { schema, type Db } from "@binflip/db";
import type { startSwapBack } from "./swapback.js";

interface FlipProgress {
  stage: "planned" | "removed" | "added";
  received?: string;
  signatures: string[];
}

/**
 * Executes manager decisions on live positions. Every job re-reads the
 * position on chain and re-runs the engine: a stale decision (price moved
 * back, leader already closed) is dropped, never executed.
 *
 * Flip = remove the token bins above price, then add exactly the token that
 * came out above the price. Progress is stored in txs.plan, so a retry after
 * a failed add resumes at the add and never re-removes or sells the token.
 */
export function startManagement(p: {
  db: Db;
  connection: Redis;
  builder: DlmmTxBuilder;
  sender: TxSender;
  swapback: ReturnType<typeof startSwapBack>;
  config: Config;
  log: Logger;
  notifications: Queue<NotificationJob>;
  serial: <T>(fn: () => Promise<T>) => Promise<T>;
}) {
  const { db, builder, sender, config, log } = p;
  const notify = (userId: string, text: string) => p.notifications.add("notify", { userId, text }, { removeOnComplete: 1000 });
  const opts = (onSignature: (s: string) => Promise<void>) => ({ priorityMicroLamports: config.PRIORITY_FEE_MICROLAMPORTS, onSignature });

  const worker = new Worker<ManagementJob>(
    QUEUES.MANAGEMENT,
    (job) => p.serial(() => handle(job)),
    { connection: p.connection, concurrency: 1 },
  );
  worker.on("failed", async (job, err) => {
    if (!job || job.attemptsMade < (job.opts.attempts ?? 1)) return;
    const [pos] = await db.select().from(schema.positions).where(eq(schema.positions.id, job.data.positionId));
    if (pos) await notify(pos.userId, `❌ Yönetim (${job.data.kind}) başarısız: ${err.message.slice(0, 150)}. Pozisyon ${pos.ourPosition?.slice(0, 8)}… elle kontrol edin.`);
  });

  async function handle(job: Job<ManagementJob>) {
    const j = job.data;
    const key = job.id!;
    const [row] = await db
      .select()
      .from(schema.positions)
      .leftJoin(schema.copySettings, eq(schema.copySettings.leaderId, schema.positions.leaderId))
      .leftJoin(schema.leaders, eq(schema.leaders.id, schema.positions.leaderId))
      .where(eq(schema.positions.id, j.positionId));
    if (!row) return { skipped: "missing" };
    const { positions: pos, copy_settings: cs, leaders: leader } = row;
    const label = leader?.label ?? "manuel";
    if (pos.state !== "ACTIVE" || !pos.ourPosition || pos.dryRun) return { skipped: `state_${pos.state}` };

    const [existing] = await db.select().from(schema.txs).where(and(eq(schema.txs.userId, pos.userId), eq(schema.txs.idempotencyKey, key)));
    if (existing?.status === "confirmed") return { done: true };
    const progress: FlipProgress = (existing?.plan as unknown as FlipProgress) ?? { stage: "planned", signatures: [] };

    // Re-check on chain unless we are resuming a flip whose token is already out.
    const exits: ExitRules = { takeProfitBps: cs?.takeProfitBps ?? null, stopLossBps: cs?.stopLossBps ?? null, trailingStopBps: cs?.trailingStopBps ?? null };
    const flip = flipParamsFrom(cs?.managementParams);
    const { state, activeId } = await readLivePosition(builder, pos);
    const d = progress.stage === "removed" ? null : decide(state, cs?.managementMode ?? pos.managementMode, exits, flip);
    if (d && d.do !== j.kind) {
      log.info({ position: pos.id, wanted: j.kind, now: d.do }, "management decision is stale, dropped");
      return { skipped: "stale" };
    }

    const [t] = existing
      ? [existing]
      : await db
          .insert(schema.txs)
          .values({ userId: pos.userId, positionId: pos.id, idempotencyKey: key, kind: j.kind, status: "planned", reason: j.reason, dryRun: false, plan: progress as never })
          .onConflictDoNothing()
          .returning();
    if (!t) return { skipped: "race" };
    const save = (v: Partial<typeof schema.txs.$inferInsert>) => db.update(schema.txs).set(v).where(eq(schema.txs.id, t.id));
    const onSignature = async (sig: string) => {
      progress.signatures.push(sig);
      await save({ status: "submitted", signature: sig, plan: progress as never });
    };
    const sendAll = async (built: BuiltTxs) => {
      for (const [i, tx] of built.txs.entries()) await sender.send(tx, built.extraSigners.get(i) ?? [], opts(onSignature));
    };
    const info = await builder.poolInfo(pos.pool);
    const tokenMint = info.mintY === WSOL_MINT ? info.mintX : info.mintY;

    if (j.kind === "close") {
      const before = await builder.tokenBalance(tokenMint);
      await sendAll(await builder.remove({ pool: pos.pool, position: pos.ourPosition, bps: 10_000, close: true }));
      const received = (await builder.tokenBalance(tokenMint)) - before;
      await save({ status: "confirmed" });
      await db.update(schema.positions).set({ state: "CLOSED", closedAt: new Date(), closeReason: j.reason }).where(eq(schema.positions.id, pos.id));
      if (received > 0n) {
        await p.swapback.enqueue({ userId: pos.userId, key: t.id, leaderEventId: null, positionId: pos.id, mint: tokenMint, pool: pos.pool, amount: received.toString(), label });
      }
      const pnl = d && d.do === "close" ? ` (PnL %${(d.pnlBps / 100).toFixed(2)})` : "";
      await notify(pos.userId, `[CANLI] ${label}: ${j.reason} ile kapatıldı${pnl}${received > 0n ? ", token SOL'e çevrilmek üzere kuyrukta" : ""}`);
      return { closed: true };
    }

    // ── flip ──
    if (progress.stage === "planned") {
      if (!d || d.do !== "flip") return { skipped: "stale" };
      const before = await builder.tokenBalance(tokenMint);
      await sendAll(await builder.removeRange({ pool: pos.pool, position: pos.ourPosition, fromBinId: d.withdraw.from, toBinId: d.withdraw.to, bps: 10_000 }));
      progress.stage = "removed";
      progress.received = ((await builder.tokenBalance(tokenMint)) - before).toString();
      await save({ plan: { ...progress, ask: d.ask, withdraw: d.withdraw } as never });
    }
    const received = BigInt(progress.received ?? "0");
    if (received > 0n) {
      // Same width as decided (= bins withdrawn, min 10), from this run's decision or the saved one on resume.
      const saved = (existing?.plan as { withdraw?: { from: number; to: number } } | undefined)?.withdraw;
      const w = d && d.do === "flip" ? d.withdraw : saved;
      const n = flip.askBins ?? Math.max(10, w ? w.to - w.from + 1 : 10);
      // Recompute the ask range from the CURRENT price: 0 spread, right above it.
      await sendAll(await builder.addToken({ pool: pos.pool, position: pos.ourPosition, fromBinId: activeId + 1, toBinId: activeId + n, amount: received, strategy: flip.askShape, slippagePct: 1 }));
    }
    progress.stage = "added";
    await save({ status: "confirmed", plan: progress as never });
    const chain = await builder.positionBins(pos.pool, pos.ourPosition);
    await db
      .update(schema.positions)
      .set({ lastFlipBinId: activeId, lowerBinId: chain.lower, upperBinId: chain.upper })
      .where(eq(schema.positions.id, pos.id));
    await notify(pos.userId, `[CANLI] ${label}: ${j.reason.replace("_", " ")} yapıldı (${progress.signatures.length} işlem); token fiyatın üstüne kondu.`);
    return { flipped: true };
  }

  return { close: () => worker.close() };
}
