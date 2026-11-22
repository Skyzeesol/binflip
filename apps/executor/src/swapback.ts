import { Queue, Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import { eq } from "drizzle-orm";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  JupiterClient,
  NoRouteError,
  QUEUES,
  SWAPBACK_MAX_ATTEMPTS,
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
}) {
  const { db, builder, sender, config, log, notifications } = p;
  const jupiter = new JupiterClient();
  const queue = new Queue<SwapBackJob>(QUEUES.SWAPBACK, { connection: p.connection });
  const notify = (userId: string, text: string) => notifications.add("notify", { userId, text }, { removeOnComplete: 1000 });
  const update = (id: string, v: Partial<typeof schema.txs.$inferInsert>) => db.update(schema.txs).set(v).where(eq(schema.txs.id, id));

  const worker = new Worker<SwapBackJob>(
    QUEUES.SWAPBACK,
    async (job: Job<SwapBackJob>) => {
      const j = job.data;
      const [row] = await db.select().from(schema.txs).where(eq(schema.txs.id, j.txId));
      if (!row || row.status === "confirmed" || row.status === "skipped") return { done: true };

      // A previous attempt broadcast something: find out what happened first.
      if (row.signature) {
        const st = await sender.status(row.signature);
        if (st === "confirmed") {
          await update(row.id, { status: "confirmed", reason: null });
          return { done: true, recovered: row.signature };
        }
      }

      const balance = await builder.tokenBalance(j.mint);
      const amount = minBig(BigInt(j.amount), balance);
      if (amount <= 0n) {
        await update(row.id, { status: "skipped", reason: "no_tokens_left" });
        return { done: true };
      }

      const slippageBps = await userSlippage(db, j.userId);
      const onSignature = async (sig: string) => void (await update(row.id, { status: "submitted", signature: sig }));
      let route = "jupiter";
      let outLamports: bigint;
      try {
        const q = await jupiter.quoteToSol(j.mint, amount, slippageBps);
        const { tx, lastValidBlockHeight } = await jupiter.buildSwap(q, p.publicKey, 2_000_000);
        await sender.sendVersioned(tx, lastValidBlockHeight, { onSignature });
        outLamports = BigInt(q.outAmount);
        route = `jupiter (${q.routePlan.map((r) => r.swapInfo.label).join(" > ")})`;
      } catch (jupErr) {
        // No route on Jupiter (or Jupiter down): fall back to the pool we LP'd in.
        log.warn({ err: (jupErr as Error).message, noRoute: jupErr instanceof NoRouteError }, "jupiter swap failed, trying pool");
        const q = await builder.swapTokenToSol({ pool: j.pool, amount, slippageBps });
        if (!q) throw new Error("nothing to swap");
        await sender.send(q.built.txs[0]!, [], { priorityMicroLamports: config.PRIORITY_FEE_MICROLAMPORTS, onSignature });
        outLamports = q.outLamports;
        route = "DLMM havuzu";
      }

      await update(row.id, { status: "confirmed", reason: null, solDelta: outLamports, tokenDelta: (-amount).toString(), attempts: job.attemptsMade + 1 });
      await notify(j.userId, `🔁 ${j.label}: token → ~${(Number(outLamports) / 1e9).toFixed(4)} SOL (${route})${job.attemptsMade ? `, ${job.attemptsMade + 1}. denemede` : ""}`);
      await sweep(j);
      return { sold: amount.toString(), route };
    },
    {
      connection: p.connection,
      concurrency: 1,
      settings: { backoffStrategy: (attemptsMade: number) => swapBackDelayMs(attemptsMade) },
    },
  );

  worker.on("failed", async (job, err) => {
    if (!job) return;
    await update(job.data.txId, { status: "planned", reason: "tokens_left_retrying", error: err.message.slice(0, 2000), attempts: job.attemptsMade });
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

  return {
    /** Enqueue a swap-back; idempotent per leader event. */
    async enqueue(j: Omit<SwapBackJob, "txId">) {
      const [row] = await db
        .insert(schema.txs)
        .values({ userId: j.userId, leaderEventId: j.leaderEventId, positionId: j.positionId, idempotencyKey: `swap_${j.key}`, kind: "swap", status: "planned", dryRun: false, tokenDelta: (-BigInt(j.amount)).toString() })
        .onConflictDoNothing()
        .returning({ id: schema.txs.id });
      if (!row) return;
      await queue.add("swapback", { ...j, txId: row.id }, {
        jobId: `swap_${j.key}`,
        attempts: SWAPBACK_MAX_ATTEMPTS,
        backoff: { type: "custom" },
        removeOnComplete: { age: 7 * 86_400 },
      });
    },
    sweepAfterClose: sweep,
    close: async () => {
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
