/** Job payloads. Everything is JSON-safe: bigints travel as strings. */

/** listener → listener worker: a leader signature to fetch and decode. */
export interface SignatureJob {
  address: string;
  signature: string;
  slot: number;
  source: "ws" | "poll";
  seenAt: number;
}

/** listener → executor: one stored leader event to plan. */
export interface ExecutionJob {
  leaderEventId: string;
}

/** executor → swapback worker: sell `amount` of `mint` back to SOL. */
export interface SwapBackJob {
  userId: string;
  /** Idempotency key suffix: the leader event id, or the management txs id. */
  key: string;
  leaderEventId: string | null;
  positionId: string | null;
  txId: string;
  mint: string;
  pool: string;
  amount: string;
  label: string;
  /** Smart Token Retention: hold instead of selling right away. */
  hold?: SwapBackHold;
}

export interface SwapBackHold {
  untilMs: number;
  /** Token price (lamports per raw unit) when the hold started. */
  startPriceLamports: number;
  /** Sell right away if the price drops more than this (bps). */
  sellOnDropBps: number;
  sellOnLeaderSell: boolean;
  leaderId: string;
  leaderAddress: string;
}

/** Redis key the listener sets when a leader sells (or sends away) a token outside an LP add. */
export const leaderSoldKey = (leaderAddress: string, mint: string) => `leader_sold:${leaderAddress}:${mint}`;

/** Retry delay for swap-backs: 30s, 1m, 2m, … capped at 15 minutes. Keeps trying until sold. */
export function swapBackDelayMs(attemptsMade: number): number {
  return Math.min(15 * 60_000, 30_000 * 2 ** Math.max(0, attemptsMade - 1));
}
export const SWAPBACK_MAX_ATTEMPTS = 1000;

/** manager → executor: act on a management decision. The executor re-checks it on chain first. */
export interface ManagementJob {
  positionId: string;
  kind: "close" | "flip" | "compound" | "close_empty" | "decrease" | "claim";
  reason: string;
  /** Requested from the panel: run it as asked, without re-deciding (only state checks). */
  manual?: boolean;
  /** decrease: share to withdraw (bps). */
  bps?: number;
  /** claim: sell the claimed token fees to SOL (LP Agent default on). */
  swapToSol?: boolean;
  /** Active bin when the manager decided; part of the job id so one bin = one action. */
  activeId: number;
}

/** api → executor: send SOL from the agent wallet to the main wallet (SWEEP_TO_ADDRESS only). */
export interface WithdrawJob {
  userId: string;
  /** Lamports; "max" = everything except the fee buffer. */
  lamports: string;
  requestId: string;
}

/** anyone → telegram: a human-readable notification. */
export interface NotificationJob {
  userId: string;
  text: string;
}

/** BullMQ job ids may not contain ':'. */
export const jobId = (...parts: string[]) => parts.join("_");
