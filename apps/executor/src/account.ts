import { Worker, type Queue } from "bullmq";
import type { Redis } from "ioredis";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { eq } from "drizzle-orm";
import { QUEUES, SWEEP_FEE_BUFFER, type Config, type Logger, type NotificationJob, type TxSender, type WithdrawJob } from "@binflip/core";
import { schema, type Db } from "@binflip/db";

/**
 * Withdraw from the agent wallet (LP Agent account panel). The destination is
 * never taken from the request: only the main wallet set on the server
 * (SWEEP_TO_ADDRESS) can receive, so a stolen panel session cannot drain funds elsewhere.
 */
export function startAccount(p: {
  db: Db;
  connection: Redis;
  sender: TxSender;
  publicKey: string;
  config: Config;
  log: Logger;
  notifications: Queue<NotificationJob>;
  serial: <T>(fn: () => Promise<T>) => Promise<T>;
}) {
  const { db, sender, config } = p;
  const worker = new Worker<WithdrawJob>(
    QUEUES.ACCOUNT,
    (job) =>
      p.serial(async () => {
        const j = job.data;
        const to = config.SWEEP_TO_ADDRESS;
        if (!to) throw new Error("SWEEP_TO_ADDRESS is not set on the server");
        const balance = BigInt(await sender.connection.getBalance(new PublicKey(p.publicKey)));
        const max = balance > SWEEP_FEE_BUFFER ? balance - SWEEP_FEE_BUFFER : 0n;
        const amount = j.lamports === "max" ? max : BigInt(j.lamports);
        if (amount <= 0n || amount > max) throw new Error(`not enough SOL: asked ${Number(amount) / 1e9}, available ${Number(max) / 1e9}`);
        const [row] = await db
          .insert(schema.txs)
          .values({ userId: j.userId, idempotencyKey: `withdraw_${j.requestId}`, kind: "withdraw", status: "planned", reason: "manual_withdraw", dryRun: false, solDelta: -amount, plan: { to } as never })
          .onConflictDoNothing()
          .returning({ id: schema.txs.id });
        if (!row) return { duplicate: true };
        const update = (v: Partial<typeof schema.txs.$inferInsert>) => db.update(schema.txs).set(v).where(eq(schema.txs.id, row.id));
        try {
          const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: new PublicKey(p.publicKey), toPubkey: new PublicKey(to), lamports: amount }));
          await sender.send(tx, [], { priorityMicroLamports: config.PRIORITY_FEE_MICROLAMPORTS, onSignature: async (sig) => void (await update({ status: "submitted", signature: sig })) });
          await update({ status: "confirmed" });
          await p.notifications.add("notify", { userId: j.userId, text: `💸 ${(Number(amount) / 1e9).toFixed(4)} SOL ana cüzdana çekildi (panelden)` }, { removeOnComplete: 1000 });
          return { sent: amount.toString() };
        } catch (err) {
          await update({ status: "failed", error: (err as Error).message.slice(0, 2000) });
          throw err;
        }
      }),
    { connection: p.connection, concurrency: 1 },
  );
  worker.on("failed", (job, err) => p.log.warn({ err: err.message, request: job?.data.requestId }, "withdraw failed"));
  return { close: () => worker.close() };
}
