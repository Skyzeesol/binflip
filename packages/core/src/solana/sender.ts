import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
  type TransactionSignature,
} from "@solana/web3.js";
import bs58 from "bs58";
import type { Signer } from "../signer.js";

export class SimulationError extends Error {
  override name = "SimulationError";
  constructor(
    message: string,
    readonly logs: string[],
  ) {
    super(message);
  }
}

export class ConfirmTimeoutError extends Error {
  override name = "ConfirmTimeoutError";
}

export interface SendOptions {
  /** micro-lamports per CU; added only if the tx has no price instruction yet. */
  priorityMicroLamports?: number;
  /** Rebroadcast interval while waiting for confirmation. */
  rebroadcastMs?: number;
  /** Stop waiting after this; the caller must check the signature before any retry. */
  confirmTimeoutMs?: number;
  /**
   * Called with the signature (and the last block height at which the tx can still land) right
   * before the first broadcast, so both can be persisted and the outcome resolved later.
   */
  onSignature?: (sig: string, lastValidBlockHeight: number) => Promise<void>;
}

export type SigOutcome = "confirmed" | "failed" | "expired" | "pending";

export interface SendResult {
  signature: TransactionSignature;
  slot: number;
  feeLamports: number | null;
}

const COMPUTE_BUDGET = ComputeBudgetProgram.programId.toBase58();

/**
 * Simulate → sign → broadcast → rebroadcast until confirmed. The signature is
 * handed to onSignature BEFORE the first send: a crash after that point must
 * be resolved by checking the signature, never by building a second tx.
 */
export class TxSender {
  constructor(
    readonly connection: Connection,
    readonly signer: Signer,
  ) {}

  /** Fill blockhash, fee payer and priority fee; returns the blockhash expiry height. */
  async prepare(tx: Transaction, opts: SendOptions = {}): Promise<number> {
    const payer = new PublicKey(this.signer.publicKey);
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = payer;
    const hasPrice = tx.instructions.some(
      (ix) => ix.programId.toBase58() === COMPUTE_BUDGET && ix.data[0] === 3, // SetComputeUnitPrice
    );
    if (!hasPrice && opts.priorityMicroLamports) {
      tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: opts.priorityMicroLamports }));
    }
    return lastValidBlockHeight;
  }

  /**
   * Without a compute-limit instruction a transaction gets 200k CU per instruction,
   * which big DLMM moves exceed (Karınca's rebalances use 0.3–0.7M with a raised
   * limit). Simulate with the maximum, then set the limit to what it used + a
   * margin: it fits, and the priority fee (paid per requested CU) stays low.
   */
  async fitComputeLimit(tx: Transaction): Promise<void> {
    // Drop any limit the SDK set (it falls back to the maximum when its own estimate fails) and measure ours.
    tx.instructions = tx.instructions.filter((ix) => !(ix.programId.toBase58() === COMPUTE_BUDGET && ix.data[0] === 2));
    const probe = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });
    tx.instructions.unshift(probe);
    const { unitsConsumed } = await this.simulate(tx);
    tx.instructions.shift();
    const units = Math.min(1_400_000, Math.ceil((unitsConsumed ?? 1_200_000) * 1.15) + 20_000);
    tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units }));
  }

  /** Simulate without signatures (sigVerify off). Throws SimulationError with program logs. */
  async simulate(tx: Transaction): Promise<{ unitsConsumed: number | null; logs: string[] }> {
    // Config (sigVerify/replaceRecentBlockhash) is only accepted for versioned transactions.
    const vtx = new VersionedTransaction(tx.compileMessage());
    const res = await this.connection.simulateTransaction(vtx, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: "confirmed",
    });
    const v = res.value;
    if (v.err) throw new SimulationError(`simulation failed: ${JSON.stringify(v.err)}`, v.logs ?? []);
    return { unitsConsumed: v.unitsConsumed ?? null, logs: v.logs ?? [] };
  }

  async sign(tx: Transaction, extra: Keypair[] = []): Promise<string> {
    if (extra.length) tx.partialSign(...extra);
    const message = tx.serializeMessage();
    const sig = await this.signer.signMessage(message);
    tx.addSignature(new PublicKey(this.signer.publicKey), Buffer.from(sig));
    if (!tx.verifySignatures()) throw new Error("signature verification failed");
    return bs58.encode(sig);
  }

  async send(tx: Transaction, extra: Keypair[] = [], opts: SendOptions = {}): Promise<SendResult> {
    const lastValid = await this.prepare(tx, opts);
    await this.fitComputeLimit(tx);
    const signature = await this.sign(tx, extra);
    await opts.onSignature?.(signature, lastValid);
    return this.broadcastAndConfirm(tx.serialize(), signature, lastValid, opts);
  }

  /**
   * Send a prebuilt versioned transaction (e.g. from Jupiter, which already set
   * blockhash, fee payer and priority fee). Same guarantees as send().
   */
  async sendVersioned(tx: VersionedTransaction, lastValidBlockHeight: number, opts: SendOptions = {}): Promise<SendResult> {
    const payer = tx.message.staticAccountKeys[0]?.toBase58();
    if (payer !== this.signer.publicKey) throw new Error(`fee payer ${payer} is not our agent wallet`);
    const sim = await this.connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: false, commitment: "confirmed" });
    if (sim.value.err) throw new SimulationError(`simulation failed: ${JSON.stringify(sim.value.err)}`, sim.value.logs ?? []);
    const sig = await this.signer.signMessage(tx.message.serialize());
    tx.addSignature(new PublicKey(this.signer.publicKey), sig);
    const signature = bs58.encode(sig);
    const lastValid = lastValidBlockHeight || (await this.connection.getBlockHeight("confirmed")) + 150;
    await opts.onSignature?.(signature, lastValid);
    return this.broadcastAndConfirm(tx.serialize(), signature, lastValid, opts);
  }

  private async broadcastAndConfirm(raw: Uint8Array, signature: string, lastValid: number, opts: SendOptions): Promise<SendResult> {
    const deadline = Date.now() + (opts.confirmTimeoutMs ?? 90_000);
    let next = 0;
    while (Date.now() < deadline) {
      if (Date.now() >= next) {
        await this.connection
          .sendRawTransaction(Buffer.from(raw), { skipPreflight: true, maxRetries: 0 })
          .catch(() => undefined); // rebroadcast errors are expected once it lands
        next = Date.now() + (opts.rebroadcastMs ?? 2_000);
      }
      const st = (await this.connection.getSignatureStatuses([signature])).value[0];
      if (st?.err) throw new Error(`transaction failed: ${JSON.stringify(st.err)}`);
      if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
        const fee = await this.connection
          .getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 1 as 0 })
          .then((t) => t?.meta?.fee ?? null)
          .catch(() => null);
        return { signature, slot: st.slot, feeLamports: fee };
      }
      const height = await this.connection.getBlockHeight("confirmed");
      if (height > lastValid) throw new ConfirmTimeoutError(`blockhash expired before ${signature} confirmed`);
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new ConfirmTimeoutError(`not confirmed in time: ${signature}`);
  }

  /**
   * The one rule for an outcome we did not see (lost reply, timeout, crash):
   *  - confirmed / failed: as the chain says (history searched);
   *  - expired: not found, AND the chain is past the tx's last valid block height, AND still not
   *    found on a second look after that (so it can never land);
   *  - pending: anything else (may still land, or the RPC has not seen it yet): wait.
   * Without a last valid block height an unseen tx is never declared expired.
   */
  async resolve(signature: string, lastValidBlockHeight: number | undefined): Promise<SigOutcome> {
    const a = await this.status(signature);
    if (a !== "unknown") return a;
    if (lastValidBlockHeight === undefined) return "pending";
    const height = await this.connection.getBlockHeight("confirmed");
    if (height <= lastValidBlockHeight) return "pending";
    const b = await this.status(signature);
    return b === "unknown" ? "expired" : b;
  }

  /** After a crash/timeout: did this signature land? */
  async status(signature: string): Promise<"confirmed" | "failed" | "unknown"> {
    const st = (await this.connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
    if (!st) return "unknown";
    if (st.err) return "failed";
    return st.confirmationStatus === "processed" ? "unknown" : "confirmed";
  }
}

/** Connection that uses the global fetch (honours NODE_USE_ENV_PROXY in sandboxes). */
export function createConnection(rpcUrl: string, wsUrl?: string): Connection {
  return new Connection(rpcUrl, {
    commitment: "confirmed",
    ...(wsUrl ? { wsEndpoint: wsUrl } : {}),
    fetch: globalThis.fetch as never,
  });
}
