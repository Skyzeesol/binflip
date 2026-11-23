import { Queue, Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import { and, eq } from "drizzle-orm";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  JupiterClient,
  QUEUES,
  SWAPBACK_MAX_ATTEMPTS,
  leaderSoldKey,
  swapBackDelayMs,
  sweepAmount,
  type Config,
  type DlmmTxBuilder,
  type Logger,
  type NotificationJob,
  type SwapBackJob,
  type TxSender,
} from "@binflip/core";
import { schema, type Db } from "@binflip/db";

/**
 * Sells tokens that came out of a copied remove/close back to SOL, like LP
 * Agent's "swap back": Jupiter first, then the same DLMM pool, retried with
 * backoff (30s → 15 min cap) until sold. Never sells more than this event
 * produced, and re-checks the last signature and the balance before every
 * attempt so a token is never sold twice.
 */
export function startSwapBack(p: {
  db: Db;
  connection: Redis;
  builder: DlmmTxBuilder;
  sender: TxSender;
  publicKey: string;
  config: Config;
  log: Logger;
  notifications: Queue<NotificationJob>;
  serial: <T>(fn: () => Promise<T>) => Promise<T>;
}) {
  const { db, builder, sender, config, log, notifications } = p;
  const jupiter = new JupiterClient();
  const queue = new Queue<SwapBackJob>(QUEUES.SWAPBACK, { connection: p.connection });
  const notify = (userId: string, text: string) => notifications.add("notify", { userId, text }, { removeOnComplete: 1000 });
  const update = (id: string, v: Partial<typeof schema.txs.$inferInsert>) => db.update(schema.txs).set(v).where(eq(schema.txs.id, id));

  const worker = new Worker<SwapBackJob>(
    QUEUES.SWAPBACK,
    (job: Job<SwapBackJob>) => p.serial(async () => {
      const j = job.data;
      const [row] = await db.select().from(schema.txs).where(eq(schema.txs.id, j.txId));
      if (!row || row.status === "confirmed" || row.status === "skipped") return { done: true };

      const progress = (row.plan ?? {}) as { remaining?: string; lastValidBlockHeight?: number; route?: string };
      async function finish(signature: string, route: string) {
        const tx = await sender.connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
        if (!tx?.meta) throw new Error("confirmed swap details are not available yet");
        // The wallet is the fee payer. Its balance delta is actual net SOL received.
        const received = BigInt(tx.meta.postBalances[0]!) - BigInt(tx.meta.preBalances[0]!);
        await update(j.txId, { status: "confirmed", reason: j.hold ? "retention_sold" : null, solDelta: received, error: null });
        await notify(j.userId, `🔁 ${j.label}: token → ${(Number(received) / 1e9).toFixed(4)} SOL (${route})`);
        await sweep(j);
        return { route };
      }

      if (row.signature) {
        if (await sender.status(row.signature) === "confirmed") return finish(row.signature, progress.route ?? "swap");
        if (!(await sender.canReplace(row.signature, progress.lastValidBlockHeight))) {
          throw new Error("waiting for the previous swap to settle");
        }
      }

      const balance = await builder.tokenBalance(j.mint);
      const amount = minBig(BigInt(progress.remaining ?? j.amount), balance);
      if (amount <= 0n) {
        await update(row.id, { status: "skipped", reason: "no_tokens_left" });
        return { done: true };
      }

      const slippageBps = await userSlippage(db, j.userId);
      let submitted = false;
      const save = (route: string) => async (signature: string, lastValidBlockHeight: number) => {
        submitted = true;
        await update(row.id, {
          status: "submitted", signature, tokenDelta: (-amount).toString(),
          plan: { ...progress, route, lastValidBlockHeight },
        });
      };
      try {
        const q = await jupiter.quoteToSol(j.mint, amount, slippageBps);
        const { tx, lastValidBlockHeight } = await jupiter.buildSwap(q, p.publicKey, 2_000_000);
        const result = await sender.sendVersioned(tx, lastValidBlockHeight, { onSignature: save("Jupiter") });
        return await finish(result.signature, "Jupiter");
      } catch (err) {
        if (submitted) throw err;
        log.warn({ err }, "jupiter failed before submission, trying pool");
      }

      const q = await builder.swapTokenToSol({ pool: j.pool, amount, slippageBps });
      if (!q) throw new Error("nothing to swap");
      const result = await sender.send(q.built.txs[0]!, [], {
        priorityMicroLamports: config.PRIORITY_FEE_MICROLAMPORTS, onSignature: save("DLMM havuzu"),
      });
      return finish(result.signature, "DLMM havuzu");
    }),
    {
      connection: p.connection,
      concurrency: 1,
      settings: { backoffStrategy: (attemptsMade: number) => swapBackDelayMs(attemptsMade) },
    },
  );

  worker.on("failed", async (job, err) => {
    if (!job) return;
    await update(job.data.txId, { reason: "tokens_left_retrying", error: err.message.slice(0, 2000), attempts: job.attemptsMade });
    log.warn({ attempt: job.attemptsMade, err: err.message }, "swap back failed, will retry");
    if (job.attemptsMade === 1) {
      await notify(job.data.userId, `⚠️ ${job.data.label}: token SOL'e çevrilemedi (${err.message.slice(0, 100)}). Satılana kadar tekrar denenecek.`);
    }
  });

  async function sweep(j: SwapBackJob) {
    if (!config.SWEEP_TO_ADDRESS) return;
    const balance = BigInt(await builder.connection.getBalance(new PublicKey(p.publicKey)));
    const amount = sweepAmount(balance, BigInt(config.SWEEP_KEEP_LAMPORTS), BigInt(config.SWEEP_MIN_LAMPORTS));
    if (!amount) return;
    const [row] = await db
      .insert(schema.txs)
      .values({ userId: j.userId, leaderEventId: j.leaderEventId, positionId: j.positionId, idempotencyKey: `sweep_${j.key}`, kind: "swap", status: "planned", reason: "profit_sweep", dryRun: false, solDelta: -amount })
      .onConflictDoNothing()
      .returning({ id: schema.txs.id });
    if (!row) return;
    try {
      const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: new PublicKey(p.publicKey), toPubkey: new PublicKey(config.SWEEP_TO_ADDRESS), lamports: amount }));
      await sender.send(tx, [], { priorityMicroLamports: config.PRIORITY_FEE_MICROLAMPORTS, onSignature: async (sig) => void (await update(row.id, { status: "submitted", signature: sig })) });
      await update(row.id, { status: "confirmed" });
      await notify(j.userId, `💸 ${(Number(amount) / 1e9).toFixed(4)} SOL ana cüzdana süpürüldü`);
    } catch (err) {
      await update(row.id, { status: "failed", error: (err as Error).message.slice(0, 2000) });
    }
  }

  async function heldRows(userId: string, mint: string) {
    const rows = await db.select().from(schema.txs).where(and(eq(schema.txs.userId, userId), eq(schema.txs.kind, "swap"), eq(schema.txs.status, "planned"), eq(schema.txs.reason, "holding")));
    return rows.filter((r) => (r.plan as { mint?: string } | null)?.mint === mint);
  }

  /**
   * Smart Token Retention early-sell conditions (LP Agent): price drops more than X%,
   * the leader sells the token, or retention is turned off / the copy paused or stopped.
   */
  const watch = setInterval(() => {
    void (async () => {
      const held = await queue.getDelayed(0, 200);
      for (const job of held) {
        const h = job.data.hold;
        if (!h) continue;
        let why: string | null = null;
        const [l] = await db.select().from(schema.leaders).where(eq(schema.leaders.id, h.leaderId));
        const [cs] = l ? await db.select().from(schema.copySettings).where(eq(schema.copySettings.leaderId, l.id)) : [];
        if (!l) why = "kopya durduruldu";
        else if (l.status === "paused") why = "kopya duraklatıldı";
        else if (!cs?.smartTokenRetention) why = "token tutma kapatıldı";
        if (!why && h.sellOnLeaderSell && (await p.connection.exists(leaderSoldKey(h.leaderAddress, job.data.mint)))) why = "lider token'ı sattı";
        if (!why) {
          const info = await builder.poolInfo(job.data.pool).catch(() => null);
          if (info) {
            const px = Math.pow(1 + info.binStep / 10_000, info.activeBinId);
            const price = info.solIsY ? px : 1 / px;
            if (price < h.startPriceLamports * (1 - h.sellOnDropBps / 10_000)) why = `fiyat %${((1 - price / h.startPriceLamports) * 100).toFixed(1)} düştü`;
          }
        }
        if (why) {
          await update(job.data.txId, { reason: "holding_early_sell" });
          await job.promote();
          await notify(job.data.userId, `⏩ ${job.data.label}: tutulan token erken satılıyor (${why}).`);
        }
      }
    })().catch((err) => log.warn({ err: (err as Error).message }, "retention watch failed"));
  }, 10_000);

  return {
    /** Enqueue a swap-back; idempotent per leader event. */
    async enqueue(j: Omit<SwapBackJob, "txId">) {
      const [row] = await db
        .insert(schema.txs)
        .values({
          userId: j.userId,
          leaderEventId: j.leaderEventId,
          positionId: j.positionId,
          idempotencyKey: `swap_${j.key}`,
          kind: "swap",
          status: "planned",
          dryRun: false,
          tokenDelta: (-BigInt(j.amount)).toString(),
          ...(j.hold ? { reason: "holding", plan: { mint: j.mint, pool: j.pool, remaining: j.amount, holdUntil: new Date(j.hold.untilMs).toISOString() } as never } : {}),
        })
        .onConflictDoNothing()
        .returning({ id: schema.txs.id });
      const existing = row ?? (await db.select({ id: schema.txs.id, status: schema.txs.status }).from(schema.txs).where(and(
        eq(schema.txs.userId, j.userId), eq(schema.txs.idempotencyKey, `swap_${j.key}`),
      )))[0];
      if (!existing || ("status" in existing && (existing.status === "confirmed" || existing.status === "skipped"))) return;
      await queue.add("swapback", { ...j, txId: existing.id }, {
        jobId: `swap_${j.key}`,
        ...(j.hold ? { delay: Math.max(0, j.hold.untilMs - Date.now()) } : {}),
        attempts: SWAPBACK_MAX_ATTEMPTS,
        backoff: { type: "custom" },
        removeOnComplete: { age: 7 * 86_400 },
      });
    },
    sweepAfterClose: sweep,
    /** Kept tokens of `mint` still on hold for this user (Smart Token Retention). */
    heldAmount: async (userId: string, mint: string) => (await heldRows(userId, mint)).reduce((s, r) => s + BigInt((r.plan as { remaining: string }).remaining), 0n),
    /** A re-add uses `amount` of the kept tokens: reduce or cancel the pending sales. Returns what was taken. */
    takeHeld: async (userId: string, mint: string, amount: bigint) => {
      let left = amount;
      for (const r of await heldRows(userId, mint)) {
        if (left <= 0n) break;
        const rem = BigInt((r.plan as { remaining: string }).remaining);
        const use = rem < left ? rem : left;
        left -= use;
        if (rem - use <= 0n) {
          await update(r.id, { status: "skipped", reason: "reused_by_readd", plan: { ...(r.plan as object), remaining: "0" } as never });
          const job = await queue.getJob(r.idempotencyKey);
          await job?.remove().catch(() => undefined);
        } else {
          await update(r.id, { plan: { ...(r.plan as object), remaining: (rem - use).toString() } as never });
        }
      }
      return amount - left;
    },
    /** "Sell now" (panel) or an early-sell condition: run the held sale immediately. */
    sellNow: async (txId: string) => {
      const [r] = await db.select().from(schema.txs).where(eq(schema.txs.id, txId));
      if (!r || r.reason !== "holding") return false;
      const job = await queue.getJob(r.idempotencyKey);
      if (!job || !(await job.isDelayed())) return false;
      await update(r.id, { reason: "holding_sell_now" });
      await job.promote();
      return true;
    },
    close: async () => {
      clearInterval(watch);
      await worker.close();
      await queue.close();
    },
  };
}

async function userSlippage(db: Db, userId: string): Promise<number> {
  const [r] = await db.select({ s: schema.userRiskSettings.slippageBps }).from(schema.userRiskSettings).where(eq(schema.userRiskSettings.userId, userId));
  return r?.s ?? 300;
}

const minBig = (a: bigint, b: bigint) => (a < b ? a : b);
