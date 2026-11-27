/**
 * Flip = (1) remove the token bins above the price, (2) add exactly the token that came out above the price.
 * Each step is recorded BEFORE its first transaction is sent (how many txs, when), and every signature is
 * saved as it is produced. A restart first reconciles the recorded signatures with the chain:
 *   - landed      → the step happened; take the token amount from the transactions themselves, move on;
 *   - not landed  → nothing happened (all failed, or expired without landing); the step may be built again;
 *   - uncertain   → still possibly in flight: build nothing, try again later;
 *   - partial     → some txs of a multi-tx step landed: stop and ask a human.
 * So a crash after a confirmed remove never repeats the remove and never strands the token.
 */

export type SigStatus = "confirmed" | "failed" | "unknown";

export interface StepRecord {
  /** Transactions this step consists of. */
  planned: number;
  sigs: string[];
  startedAt: number;
}

export interface FlipProgress {
  stage: "planned" | "removed" | "added";
  received?: string;
  signatures: string[];
  remove?: StepRecord;
  add?: StepRecord;
  /** What the remove takes out: token (x, down flips) or SOL (y, back flip), and where it goes back in. */
  withdraw?: FlipTarget;
}

export interface FlipTarget {
  from: number;
  to: number;
  side?: "x" | "y";
  ask?: { from: number; to: number };
}

export type StepOutcome = "landed" | "not_landed" | "uncertain" | "partial";

/** A transaction not seen after this long can no longer land (its blockhash expired, ~60–90 s). */
export const STEP_EXPIRY_MS = 3 * 60_000;

export function stepOutcome(step: StepRecord, statuses: SigStatus[], now: number, expiryMs = STEP_EXPIRY_MS): StepOutcome {
  const confirmed = statuses.filter((s) => s === "confirmed").length;
  const expired = now - step.startedAt > expiryMs;
  const pending = statuses.some((s) => s === "unknown") || (statuses.length < step.planned && !expired);
  if (pending && !expired) return "uncertain";
  if (confirmed === 0) return "not_landed";
  if (confirmed === step.planned) return "landed";
  return "partial";
}

export interface BuiltLike {
  txs: unknown[];
  extraSigners: Map<number, unknown[]>;
}

export interface FlipDeps {
  /** Persist progress (txs.plan). */
  save(p: FlipProgress): Promise<void>;
  statuses(sigs: string[]): Promise<SigStatus[]>;
  /** What our wallet received in these confirmed txs: raw token (side x) or SOL lamports (side y). */
  tokenDelta(sigs: string[], side: "x" | "y"): Promise<bigint>;
  /** Is the flip still wanted at the current price? Asked only before a (new) remove. Returns what to withdraw. */
  decide(): Promise<FlipTarget | null>;
  buildRemove(w: FlipTarget): Promise<BuiltLike>;
  buildAdd(received: bigint, w: FlipTarget | undefined): Promise<BuiltLike>;
  send(tx: unknown, extra: unknown[], onSignature: (sig: string) => Promise<void>): Promise<void>;
  now(): number;
}

export type FlipResult = { flipped: true; received: bigint } | { skipped: "stale" } | { review: string } | { waiting: string };

export async function runFlip(progress: FlipProgress, deps: FlipDeps): Promise<FlipResult> {
  const sendStep = async (name: "remove" | "add", built: BuiltLike) => {
    const step: StepRecord = { planned: built.txs.length, sigs: [], startedAt: deps.now() };
    progress[name] = step;
    await deps.save(progress); // the step exists before anything can land
    for (const [i, tx] of built.txs.entries()) {
      await deps.send(tx, built.extraSigners.get(i) ?? [], async (sig) => {
        step.sigs.push(sig);
        progress.signatures.push(sig);
        await deps.save(progress);
      });
    }
  };
  const reconcile = async (step: StepRecord) => stepOutcome(step, await deps.statuses(step.sigs), deps.now());

  // 1) The remove.
  if (progress.stage === "planned") {
    if (progress.remove) {
      const o = await reconcile(progress.remove);
      if (o === "uncertain") return { waiting: "remove" };
      if (o === "partial") return { review: "Flip çekiminin bir kısmı zincire geçti, bir kısmı geçmedi" };
      if (o === "landed") {
        progress.received = (await deps.tokenDelta(progress.remove.sigs, progress.withdraw?.side ?? "x")).toString();
        progress.stage = "removed";
        await deps.save(progress);
      } else delete progress.remove; // nothing happened: decide again below
    }
    if (progress.stage === "planned") {
      const w = await deps.decide();
      if (!w) return { skipped: "stale" };
      progress.withdraw = w;
      await sendStep("remove", await deps.buildRemove(w));
      progress.received = (await deps.tokenDelta(progress.remove!.sigs, w.side ?? "x")).toString();
      progress.stage = "removed";
      await deps.save(progress);
    }
  }

  // 2) The add of exactly what came out.
  const received = BigInt(progress.received ?? "0");
  if (progress.stage === "removed") {
    if (progress.add) {
      const o = await reconcile(progress.add);
      if (o === "uncertain") return { waiting: "add" };
      if (o === "partial") return { review: "Flip eklemesinin bir kısmı zincire geçti, bir kısmı geçmedi" };
      if (o === "landed") {
        progress.stage = "added";
        await deps.save(progress);
      } else delete progress.add;
    }
    if (progress.stage === "removed") {
      if (received > 0n) await sendStep("add", await deps.buildAdd(received, progress.withdraw));
      progress.stage = "added";
      await deps.save(progress);
    }
  }
  return { flipped: true, received };
}
