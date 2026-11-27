import { Worker, type Job, type Queue } from "bullmq";
import type { Redis } from "ioredis";
import { and, eq, sql } from "drizzle-orm";
import {
  QUEUES,
  WSOL_MINT,
  decide,
  flipParamsFrom,
  readLivePosition,
  shouldCompound,
  compoundRanges,
  hybridAdds,
  type BuiltTxs,
  type Config,
  type DlmmTxBuilder,
  type DammTxBuilder,
  type ExitRules,
  type Logger,
  type ManagementJob,
  type NotificationJob,
  type TxSender,
} from "@binflip/core";
import { schema, type Db } from "@binflip/db";
import type { startSwapBack } from "./swapback.js";
import { runFlip, type FlipProgress } from "./flipSteps.js";

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
  damm: DammTxBuilder;
  sender: TxSender;
  swapback: ReturnType<typeof startSwapBack>;
  config: Config;
  log: Logger;
  notifications: Queue<NotificationJob>;
  serial: <T>(fn: () => Promise<T>) => Promise<T>;
}) {
  const { db, builder, sender, config, log } = p;
  const notify = (userId: string, text: string) => p.notifications.add("notify", { userId, text, kind: "manage" }, { removeOnComplete: 1000 });
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
    const { positions: pos, copy_settings: copySet, leaders: leader } = row;
    // Positions the user opened themselves follow manual_settings instead of a leader's copy settings.
    const manual = pos.leaderId ? null : (await db.select().from(schema.manualSettings).where(eq(schema.manualSettings.userId, pos.userId)))[0];
    if (!pos.leaderId && pos.origin !== "panel" && pos.origin !== "telegram" && manual && !manual.enabled) return { skipped: "manual_off" };
    const cs = copySet ?? manual ?? null;
    const label = leader?.label ?? "manuel";
    if (j.kind === "close_empty") return closeIfStillEmpty(pos, label);
    if (j.manual) return manualAction(pos, j, key, label);
    if (pos.protocol === "damm_v2") return dammExit(pos, label, key, j);
    if (pos.state !== "ACTIVE" || !pos.ourPosition || pos.dryRun) return { skipped: `state_${pos.state}` };

    let [existing] = await db.select().from(schema.txs).where(and(eq(schema.txs.userId, pos.userId), eq(schema.txs.idempotencyKey, key)));
    if (existing?.status === "confirmed") return { done: true };
    if (!existing && j.kind === "flip") {
      // A flip of this position that never finished (other job id, e.g. a later tick at another bin):
      // finish THAT one first, from its recorded signatures, instead of starting a second remove.
      const [open] = await db
        .select()
        .from(schema.txs)
        .where(and(eq(schema.txs.positionId, pos.id), eq(schema.txs.kind, "flip"), sql`${schema.txs.status} in ('planned', 'submitted')`, sql`${schema.txs.plan} ? 'remove'`));
      if (open) existing = open;
    }
    const progress: FlipProgress = (existing?.plan as unknown as FlipProgress) ?? { stage: "planned", signatures: [] };
    // A flip with a recorded step resumes from the chain, not from a new decision.
    const resumingFlip = j.kind === "flip" && (progress.stage !== "planned" || !!progress.remove);

    // Re-check on chain unless we are resuming a flip whose token is already out.
    const exits: ExitRules = pos.exitRulesSaved
      ? { takeProfitBps: pos.takeProfitBps, stopLossBps: pos.stopLossBps, trailingStopBps: pos.trailingStopBps }
      : { takeProfitBps: cs?.takeProfitBps ?? null, stopLossBps: cs?.stopLossBps ?? null, trailingStopBps: cs?.trailingStopBps ?? null };
    const own = pos.origin === "panel" || pos.origin === "telegram";
    const flip = flipParamsFrom(own ? (pos.managementParams ?? cs?.managementParams) : cs?.managementParams);
    const { state, activeId, binStep, feeX, feeY } = await readLivePosition(builder, pos);
    const decideNow = () => decide(state, own ? pos.managementMode : (cs?.managementMode ?? pos.managementMode), exits, flip);
    const d = resumingFlip ? null : decideNow();
    if (j.kind === "compound") {
      // Exits and flips win over compounding; and fees must still be worth it.
      const c = shouldCompound({ feeX, feeY, activeId, binStep, lastCompoundAt: pos.lastCompoundAt, openedAt: pos.openedAt, intervalMinutes: own ? pos.compoundMinutes : (cs?.compoundIntervalMinutes ?? null), minLamports: BigInt(config.COMPOUND_MIN_LAMPORTS) });
      if (d?.do !== "hold" || c.do !== "compound") return { skipped: "stale" };
      return compound(pos, label, key, feeX, feeY, activeId);
    }
    if (d && d.do !== j.kind) {
      log.info({ position: pos.id, wanted: j.kind, now: d.do }, "management decision is stale, dropped");
      return { skipped: "stale" };
    }

    const [t] = existing
      ? [existing]
      : await db
          .insert(schema.txs)
          .values({ userId: pos.userId, positionId: pos.id, idempotencyKey: key, kind: j.kind as "close" | "flip" | "reshape", status: "planned", reason: j.reason, dryRun: false, plan: progress as never })
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

    // ── Precision Hybrid / RL: one rebalance_liquidity, same range, 50% spot + 50% bid-ask around the price ──
    if (j.kind === "reshape") {
      // Explicit bounds: without them the program only empties the active bin (seen in mainnet simulation).
      const removes = [{ minBinId: state.lowerBinId, maxBinId: state.upperBinId, bps: 10_000 }];
      const held = { x: BigInt(Math.floor(state.bins.reduce((s, b) => s + b.x, 0))), y: BigInt(Math.floor(state.bins.reduce((s, b) => s + b.y, 0))) };
      // Swapless: each side goes back on its own side, minus a hair so the deposit never exceeds what came out.
      const keep = (v: bigint) => (v * 995n) / 1000n;
      const adds = hybridAdds(state.lowerBinId, state.upperBinId, activeId, { x: keep(held.x), y: keep(held.y) }, binStep);
      const built = await builder.rebalanceOne({ pool: pos.pool, position: pos.ourPosition, removes, adds, favorX: false, claimFee: false, maxActiveBinSlippage: 5, slippagePct: 5 });
      const before = await builder.tokenBalance(tokenMint);
      await sendAll(built);
      const left = (await builder.tokenBalance(tokenMint)) - before;
      if (left > 0n) await p.swapback.enqueue({ userId: pos.userId, key: t.id, leaderEventId: null, positionId: pos.id, mint: tokenMint, pool: pos.pool, amount: left.toString(), label });
      await save({ status: "confirmed", plan: { signatures: progress.signatures, activeId, adds: adds.length } as never });
      const chain = await builder.positionBins(pos.pool, pos.ourPosition);
      await db.update(schema.positions).set({ lastFlipBinId: activeId, lowerBinId: chain.lower, upperBinId: chain.upper }).where(eq(schema.positions.id, pos.id));
      await notify(pos.userId, `[CANLI] ${label}: Precision Hybrid reshape yapıldı (fiyat ${d && d.do === "reshape" ? d.movedBins : "?"} bin kaydı), likidite yeni fiyatın etrafında %50 spot + %50 bid-ask.`);
      return { reshaped: true };
    }

    // ── flip: remove the token bins, then add exactly what came out above the price (see flipSteps.ts) ──
    const owner = builder.owner.toBase58();
    const r = await runFlip(progress, {
      save: async (pr) => {
        await save({ plan: pr as never, ...(pr.signatures.length ? { status: "submitted", signature: pr.signatures[pr.signatures.length - 1] } : {}) });
      },
      statuses: (sigs) => Promise.all(sigs.map((s) => sender.status(s).catch(() => "unknown" as const))),
      tokenDelta: async (sigs) => {
        let delta = 0n;
        for (const s of sigs) {
          const tx = await builder.connection.getTransaction(s, { commitment: "confirmed", maxSupportedTransactionVersion: 1 as 0 });
          if (!tx?.meta) throw new Error(`flip: transaction ${s} not readable yet`);
          const bal = (list: typeof tx.meta.postTokenBalances) =>
            (list ?? []).filter((b) => b.owner === owner && b.mint === tokenMint).reduce((t, b) => t + BigInt(b.uiTokenAmount.amount), 0n);
          delta += bal(tx.meta.postTokenBalances) - bal(tx.meta.preTokenBalances);
        }
        return delta;
      },
      decide: async () => {
        const now = d ?? decideNow();
        return now.do === "flip" ? now.withdraw : null;
      },
      buildRemove: (w) => builder.removeRange({ pool: pos.pool, position: pos.ourPosition!, fromBinId: w.from, toBinId: w.to, bps: 10_000 }),
      buildAdd: async (amount, w) => {
        // Same width as decided (= bins withdrawn, min 10); the ask range starts right above the CURRENT price.
        const n = flip.askBins ?? Math.max(10, w ? w.to - w.from + 1 : 10);
        const px = (await builder.poolInfo(pos.pool)).activeBinId;
        return builder.addToken({ pool: pos.pool, position: pos.ourPosition!, fromBinId: px + 1, toBinId: px + n, amount, strategy: flip.askShape, slippagePct: 1 });
      },
      send: (tx, extra, onSig) => sender.send(tx as never, extra as never, opts(onSig)).then(() => undefined),
      now: () => Date.now(),
    });
    if ("skipped" in r) {
      await save({ status: "skipped", reason: "stale" });
      return r;
    }
    if ("waiting" in r) throw new Error(`flip ${r.waiting} adımı hâlâ zincirde bekliyor; yeni işlem üretilmedi, tekrar bakılacak`);
    if ("review" in r) {
      await save({ status: "failed", reason: "partial_needs_review" });
      await notify(pos.userId, `⚠️ ${label}: ${r.review}. Yeni işlem gönderilmedi; pozisyonu Solscan'den kontrol edin. İmzalar: ${progress.signatures.join(", ")}`);
      return r;
    }
    await save({ status: "confirmed", plan: progress as never });
    const chain = await builder.positionBins(pos.pool, pos.ourPosition);
    const nowActive = (await builder.poolInfo(pos.pool)).activeBinId;
    await db
      .update(schema.positions)
      .set({ lastFlipBinId: nowActive, lowerBinId: chain.lower, upperBinId: chain.upper })
      .where(eq(schema.positions.id, pos.id));
    await notify(pos.userId, `[CANLI] ${label}: ${j.reason.replace("_", " ")} yapıldı (${progress.signatures.length} işlem); token fiyatın üstüne kondu.`);
    return { flipped: true };
  }

  /** LP Agent: an empty copy whose funding never came is closed after ~1 minute; the rent comes back. */
  async function closeIfStillEmpty(pos: typeof schema.positions.$inferSelect, label: string) {
    if (pos.state !== "OPENING" || pos.dryRun) return { skipped: "funded_or_gone" };
    if (!pos.ourPosition) {
      // DAMM V2 empty opens never touched the chain: just close the record.
      await db.update(schema.positions).set({ state: "CLOSED", closedAt: new Date(), closeReason: "unfunded_empty" }).where(eq(schema.positions.id, pos.id));
      return { closedEmpty: true };
    }
    const chain = await builder.positionBins(pos.pool, pos.ourPosition);
    if (chain.bins.some((b) => b.x > 0 || b.y > 0)) return { skipped: "funded" };
    const built = await builder.remove({ pool: pos.pool, position: pos.ourPosition, bps: 10_000, close: true });
    for (const [i, tx] of built.txs.entries()) await sender.send(tx, built.extraSigners.get(i) ?? [], { priorityMicroLamports: config.PRIORITY_FEE_MICROLAMPORTS });
    await db.update(schema.positions).set({ state: "CLOSED", closedAt: new Date(), closeReason: "unfunded_empty" }).where(eq(schema.positions.id, pos.id));
    await notify(pos.userId, `[CANLI] ${label}: fonlama gelmedi, boş kopya kapatıldı ve rent geri alındı.`);
    return { closedEmpty: true };
  }

  /** DAMM V2 copies: TP/SL/trailing exits (no flips — those are a DLMM bin strategy). Re-checked on chain. */
  async function dammExit(pos: typeof schema.positions.$inferSelect, label: string, key: string, j: ManagementJob) {
    if (j.kind !== "close" || pos.state !== "ACTIVE" || !pos.ourPosition) return { skipped: "not_applicable" };
    const value = await p.damm.positionValue(pos.pool, pos.ourPosition);
    const exits: ExitRules = pos.exitRulesSaved
      ? { takeProfitBps: pos.takeProfitBps, stopLossBps: pos.stopLossBps, trailingStopBps: pos.trailingStopBps }
      : { takeProfitBps: null, stopLossBps: null, trailingStopBps: null };
    const d = decide({ bins: [{ id: 0, x: 0, y: value }], activeId: 0, binStep: 1, depositedY: Number(pos.depositedSol), claimedFeesY: 0, peakY: pos.peakValue ? Number(pos.peakValue) * 1e9 : value, entryActiveId: 0, lastFlipActiveId: null, lowerBinId: 0, upperBinId: 0 }, "mirror", exits);
    if (d.do !== "close") return { skipped: "stale" };
    const [t] = await db.insert(schema.txs).values({ userId: pos.userId, positionId: pos.id, idempotencyKey: key, kind: "close", status: "planned", reason: d.reason, dryRun: false }).onConflictDoNothing().returning();
    if (!t) return { skipped: "duplicate" };
    const info = await p.damm.poolInfo(pos.pool);
    const mint = info.solIsA ? info.mintB : info.mintA;
    const before = await builder.tokenBalance(mint);
    const built = await p.damm.remove({ pool: pos.pool, position: pos.ourPosition, bps: 10_000, close: true });
    for (const [i, tx] of built.txs.entries()) await sender.send(tx, built.extraSigners.get(i) ?? [], opts(async (sig) => void (await db.update(schema.txs).set({ status: "submitted", signature: sig }).where(eq(schema.txs.id, t.id)))));
    const received = (await builder.tokenBalance(mint)) - before;
    await db.update(schema.txs).set({ status: "confirmed" }).where(eq(schema.txs.id, t.id));
    await db.update(schema.positions).set({ state: "CLOSED", closedAt: new Date(), closeReason: d.reason, currentValueSol: String(value / 1e9) }).where(eq(schema.positions.id, pos.id));
    if (received > 0n) await p.swapback.enqueue({ userId: pos.userId, key: t.id, leaderEventId: null, positionId: pos.id, mint, pool: pos.pool, amount: received.toString(), label });
    await notify(pos.userId, `[CANLI] ${label}: DAMM V2 kopya ${d.reason} ile kapatıldı (PnL %${(d.pnlBps / 100).toFixed(2)})`);
    return { closed: true };
  }

  /** Claim fees, add SOL fees back below price and token fees above it (or sell them). */
  async function compound(pos: typeof schema.positions.$inferSelect, label: string, key: string, feeX: bigint, feeY: bigint, activeId: number, reason = "auto_compound") {
    const [t] = await db
      .insert(schema.txs)
      .values({ userId: pos.userId, positionId: pos.id, idempotencyKey: key, kind: "compound", status: "planned", reason, dryRun: false })
      .onConflictDoNothing()
      .returning();
    if (!t) return { skipped: "duplicate" };
    const sigs: string[] = [];
    const onSignature = async (sig: string) => {
      sigs.push(sig);
      await db.update(schema.txs).set({ status: "submitted", signature: sig }).where(eq(schema.txs.id, t.id));
    };
    const sendAll = async (built: BuiltTxs) => {
      for (const [i, tx] of built.txs.entries()) await sender.send(tx, built.extraSigners.get(i) ?? [], opts(onSignature));
    };
    const pool = pos.pool;
    const position = pos.ourPosition!;
    await sendAll(await builder.claim({ pool, position }));
    const chain = await builder.positionBins(pool, position);
    const ranges = compoundRanges(chain.lower, chain.upper, activeId);
    const shape = "spot" as const; // HawkFi default: compounded fees spread evenly over the range
    const lines: string[] = [];
    if (feeY > 0n && ranges.sol) {
      await sendAll(await builder.add({ pool, position, lowerBinId: ranges.sol.from, upperBinId: ranges.sol.to, amountSol: feeY, strategy: shape, slippagePct: 1 }));
      lines.push(`${(Number(feeY) / 1e9).toFixed(4)} SOL`);
    }
    if (feeX > 0n) {
      const info = await builder.poolInfo(pool);
      const tokenMint = info.mintY === WSOL_MINT ? info.mintX : info.mintY;
      if (ranges.token) {
        await sendAll(await builder.addToken({ pool, position, fromBinId: ranges.token.from, toBinId: ranges.token.to, amount: feeX, strategy: shape, slippagePct: 1 }));
        lines.push("token fee'leri fiyatın üstüne");
      } else {
        await p.swapback.enqueue({ userId: pos.userId, key: t.id, leaderEventId: null, positionId: pos.id, mint: tokenMint, pool, amount: feeX.toString(), label });
        lines.push("token fee'leri SOL'e çevrilmek üzere kuyrukta");
      }
    }
    await db.update(schema.txs).set({ status: "confirmed", solDelta: -feeY, plan: { signatures: sigs, feeX: feeX.toString(), feeY: feeY.toString() } as never }).where(eq(schema.txs.id, t.id));
    // Compounded fees are profit, not new capital: depositedSol stays, so PnL shows them as gain.
    const info = await builder.poolInfo(pool);
    const feesValue = Number(feeY) + Number(feeX) * Math.pow(1 + info.binStep / 10_000, activeId);
    await addClaimed(pos.id, feesValue);
    // Token fees sold to SOL leave the position; only what went back in counts as compounded.
    const compounded = (feeY > 0n && ranges.sol ? Number(feeY) : 0) + (feeX > 0n && ranges.token ? feesValue - Number(feeY) : 0);
    await db
      .update(schema.positions)
      .set({ lastCompoundAt: new Date(), compoundedFeeSol: sql`${schema.positions.compoundedFeeSol} + ${String(compounded / 1e9)}::numeric` })
      .where(eq(schema.positions.id, pos.id));
    await notify(pos.userId, `[CANLI] ${label}: auto-compound (${lines.join(", ") || "sadece claim"}), ${sigs.length} işlem`);
    return { compounded: true };
  }

  async function addClaimed(positionId: string, lamports: number) {
    if (lamports <= 0) return;
    await db
      .update(schema.positions)
      .set({ claimedFeeSol: sql`${schema.positions.claimedFeeSol} + ${String(lamports / 1e9)}::numeric`, unclaimedFeeSol: "0" })
      .where(eq(schema.positions.id, positionId));
  }

  /**
   * Actions the user asked for in the panel (LP Agent "Manage Positions"):
   * zap out (close), decrease by %, claim fees (optionally sold to SOL), compound.
   * They run as asked: only the position state is checked, the engine is not consulted.
   */
  async function manualAction(pos: typeof schema.positions.$inferSelect, j: ManagementJob, key: string, label: string) {
    if (pos.state !== "ACTIVE") return { skipped: `state_${pos.state}` };
    const bps = j.kind === "close" ? 10_000 : Math.min(10_000, Math.max(1, j.bps ?? 10_000));
    const kind = j.kind === "decrease" ? "remove" : j.kind === "claim" ? "claim" : j.kind === "compound" ? "compound" : "close";
    const what = j.kind === "close" ? "kapatma (SOL'e)" : j.kind === "decrease" ? `%${bps / 100} azaltma` : j.kind === "claim" ? `fee claim${j.swapToSol ? " (SOL'e)" : ""}` : "compound";

    if (pos.dryRun) {
      const [t] = await db
        .insert(schema.txs)
        .values({ userId: pos.userId, positionId: pos.id, idempotencyKey: key, kind, status: "planned", reason: "manual", dryRun: true, plan: { bps, swapToSol: j.swapToSol ?? false } as never })
        .onConflictDoNothing()
        .returning();
      if (!t) return { skipped: "duplicate" };
      const value = pos.currentValueSol === null ? null : Number(pos.currentValueSol);
      if (j.kind === "close") {
        await db.update(schema.positions).set({ state: "CLOSED", closedAt: new Date(), closeReason: "manual" }).where(eq(schema.positions.id, pos.id));
      } else if (j.kind === "decrease") {
        // Scale the virtual position and its cost basis alike: the PnL % stays, the size shrinks.
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
      await notify(pos.userId, `[DENEME] ${label}: panelden ${what} istendi → yapardım.`);
      return { planned: true };
    }
    if (!pos.ourPosition) return { skipped: "no_position" };

    const [t] = await db
      .insert(schema.txs)
      .values({ userId: pos.userId, positionId: pos.id, idempotencyKey: key, kind, status: "planned", reason: "manual", dryRun: false, plan: { bps, swapToSol: j.swapToSol ?? false } as never })
      .onConflictDoNothing()
      .returning();
    if (!t) return { skipped: "duplicate" };
    const save = (v: Partial<typeof schema.txs.$inferInsert>) => db.update(schema.txs).set(v).where(eq(schema.txs.id, t.id));
    const sigs: string[] = [];
    const onSignature = async (sig: string) => {
      sigs.push(sig);
      await save({ status: "submitted", signature: sig });
    };
    const sendAll = async (built: BuiltTxs) => {
      for (const [i, tx] of built.txs.entries()) await sender.send(tx, built.extraSigners.get(i) ?? [], opts(onSignature));
    };

    const damm = pos.protocol === "damm_v2";
    let tokenMint: string;
    if (damm) {
      const info = await p.damm.poolInfo(pos.pool);
      tokenMint = info.solIsA ? info.mintB : info.mintA;
    } else {
      const info = await builder.poolInfo(pos.pool);
      tokenMint = info.mintY === WSOL_MINT ? info.mintX : info.mintY;
    }

    if (j.kind === "compound") {
      if (damm) return { skipped: "compound_dlmm_only" };
      await db.delete(schema.txs).where(eq(schema.txs.id, t.id)); // compound() writes its own row
      const { activeId, feeX, feeY } = await readLivePosition(builder, pos);
      return compound(pos, label, key, feeX, feeY, activeId, "manual");
    }

    const before = await builder.tokenBalance(tokenMint);
    if (j.kind === "claim") {
      const unclaimed = pos.unclaimedFeeSol === null ? 0 : Number(pos.unclaimedFeeSol) * 1e9;
      await sendAll(damm ? await p.damm.claim({ pool: pos.pool, position: pos.ourPosition }) : await builder.claim({ pool: pos.pool, position: pos.ourPosition }));
      await addClaimed(pos.id, unclaimed);
      if (j.reason === "auto_claim_sell") await db.update(schema.positions).set({ lastCompoundAt: new Date() }).where(eq(schema.positions.id, pos.id));
    } else {
      const close = bps === 10_000;
      const built = damm
        ? await p.damm.remove({ pool: pos.pool, position: pos.ourPosition, bps, close })
        : await builder.remove({ pool: pos.pool, position: pos.ourPosition, bps, close });
      await sendAll(built);
      if (close) {
        await db.update(schema.positions).set({ state: "CLOSED", closedAt: new Date(), closeReason: "manual" }).where(eq(schema.positions.id, pos.id));
      } else {
        // What was taken out leaves the cost basis too, so the remaining PnL % stays meaningful.
        await db
          .update(schema.positions)
          .set({ depositedSol: BigInt(Math.round(Number(pos.depositedSol) * (1 - bps / 10_000))) })
          .where(eq(schema.positions.id, pos.id));
      }
    }
    const received = (await builder.tokenBalance(tokenMint)) - before;
    await save({ status: "confirmed", plan: { bps, swapToSol: j.swapToSol ?? false, signatures: sigs } as never });
    const sell = j.kind !== "claim" || j.swapToSol;
    if (received > 0n && sell) {
      await p.swapback.enqueue({ userId: pos.userId, key: t.id, leaderEventId: null, positionId: pos.id, mint: tokenMint, pool: pos.pool, amount: received.toString(), label });
    }
    await notify(pos.userId, `[CANLI] ${label}: panelden ${what} yapıldı (${sigs.length} işlem)${received > 0n && sell ? ", token SOL'e çevrilmek üzere kuyrukta" : ""}.`);
    return { done: true };
  }

  return { close: () => worker.close() };
}
