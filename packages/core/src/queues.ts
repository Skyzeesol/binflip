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

/** anyone → telegram: a human-readable notification. */
export interface NotificationJob {
  userId: string;
  text: string;
}

/** BullMQ job ids may not contain ':'. */
export const jobId = (...parts: string[]) => parts.join("_");
