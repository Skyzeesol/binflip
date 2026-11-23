import { Worker, type Queue } from "bullmq";
import type { Redis } from "ioredis";
import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
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
        if (j.kind === "claim_sol") return claimSol(j);
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
          await p.notifications.add("notify", { userId: j.userId, text: `💸 ${(Number(amount) / 1e9).toFixed(4)} SOL ana cüzdana çekildi (panelden)`, kind: "sweep" }, { removeOnComplete: 1000 });
          return { sent: amount.toString() };
        } catch (err) {
          await update({ status: "failed", error: (err as Error).message.slice(0, 2000) });
          throw err;
        }
      }),
    { connection: p.connection, concurrency: 1 },
  );
  /**
   * LP Agent "Claim SOL": every token account holds ~0.002 SOL of rent. Empty ones
   * (balance 0) are closed and the rent comes back to the agent wallet.
   */
  async function claimSol(j: WithdrawJob) {
    const owner = new PublicKey(p.publicKey);
    const programs = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"].map((x) => new PublicKey(x));
    const empty: Array<{ account: PublicKey; program: PublicKey; lamports: number }> = [];
    for (const programId of programs) {
      const res = await sender.connection.getParsedTokenAccountsByOwner(owner, { programId }, "confirmed");
      for (const a of res.value) {
        const info = (a.account.data as { parsed?: { info?: { tokenAmount?: { amount?: string }; state?: string } } }).parsed?.info;
        if (info?.tokenAmount?.amount === "0" && info.state !== "frozen") empty.push({ account: a.pubkey, program: programId, lamports: a.account.lamports });
      }
    }
    if (!empty.length) {
      await p.notifications.add("notify", { userId: j.userId, text: "Claim SOL: kapatılacak boş token hesabı yok.", kind: "sweep" }, { removeOnComplete: 1000 });
      return { closed: 0 };
    }
    let closed = 0;
    let lamports = 0;
    for (let i = 0; i < empty.length; i += 20) {
      const batch = empty.slice(i, i + 20);
      // SPL Token CloseAccount (instruction 9): account, destination, owner.
      const tx = new Transaction().add(
        ...batch.map(
          (e) =>
            new TransactionInstruction({
              programId: e.program,
              keys: [
                { pubkey: e.account, isSigner: false, isWritable: true },
                { pubkey: owner, isSigner: false, isWritable: true },
                { pubkey: owner, isSigner: true, isWritable: false },
              ],
              data: Buffer.from([9]),
            }),
        ),
      );
      const [row] = await db
        .insert(schema.txs)
        .values({ userId: j.userId, idempotencyKey: `claimsol_${j.requestId}_${i}`, kind: "withdraw", status: "planned", reason: "claim_sol", dryRun: false, solDelta: BigInt(batch.reduce((s, e) => s + e.lamports, 0)), plan: { accounts: batch.map((e) => e.account.toBase58()) } as never })
        .onConflictDoNothing()
        .returning({ id: schema.txs.id });
      if (!row) continue;
      try {
        await sender.send(tx, [], { priorityMicroLamports: config.PRIORITY_FEE_MICROLAMPORTS, onSignature: async (sig) => void (await db.update(schema.txs).set({ status: "submitted", signature: sig }).where(eq(schema.txs.id, row.id))) });
        await db.update(schema.txs).set({ status: "confirmed" }).where(eq(schema.txs.id, row.id));
        closed += batch.length;
        lamports += batch.reduce((s, e) => s + e.lamports, 0);
      } catch (err) {
        await db.update(schema.txs).set({ status: "failed", error: (err as Error).message.slice(0, 2000) }).where(eq(schema.txs.id, row.id));
      }
    }
    await p.notifications.add("notify", { userId: j.userId, text: `♻️ Claim SOL: ${closed} boş token hesabı kapatıldı, ${(lamports / 1e9).toFixed(4)} SOL geri alındı.`, kind: "sweep" }, { removeOnComplete: 1000 });
    return { closed, lamports };
  }

  worker.on("failed", (job, err) => p.log.warn({ err: err.message, request: job?.data.requestId }, "withdraw failed"));
  return { close: () => worker.close() };
}
