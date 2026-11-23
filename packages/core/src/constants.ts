/**
 * Program IDs verified against the official SDK IDLs on 2026-11-22:
 *   @meteora-ag/dlmm@1.9.14, @meteora-ag/cp-amm-sdk@1.5.1
 */
export const PROGRAM_IDS = {
  DLMM: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
  DAMM_V2: "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG",
} as const;

export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const LAMPORTS_PER_SOL = 1_000_000_000n;

/** BullMQ queue names, shared by producers and consumers. */
export const QUEUES = {
  LEADER_EVENTS: "leader-events",
  EXECUTION: "execution",
  NOTIFICATIONS: "notifications",
  /** Sell tokens that came out of a remove/close back to SOL, retried until sold. */
  SWAPBACK: "swapback",
  /** manager → executor: a management decision (flip / exit) for one of our live positions. */
  MANAGEMENT: "management",
  /** api → executor: account actions asked in the panel (withdraw to the main wallet). */
  ACCOUNT: "account",
} as const;

/** Position lifecycle (HANDOFF §5). */
export const POSITION_STATES = [
  "OPENING",
  "ACTIVE",
  "FLIPPING",
  "CLOSING",
  "HOLDING",
  "CLOSED",
  "FAILED",
] as const;
export type PositionState = (typeof POSITION_STATES)[number];

/** Leaders holding positions shorter than this on average get a high-frequency warning. */
export const HIGH_FREQUENCY_AVG_HOLD_MINUTES = 18;
/** A capped open's smaller share applies to later adds for this long. */
export const CAPPED_SHARE_LOCK_DAYS = 30;
