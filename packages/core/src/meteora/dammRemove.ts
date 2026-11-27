/**
 * DAMM V2: the leader's partial remove mirrored as the same share of our liquidity.
 * share = removed / (left + removed), where `left` is the leader's position liquidity read from chain.
 *
 * A failed read is NOT "nothing left": that would turn any partial remove into a 100% withdraw.
 * Only a successful read gives a ratio; anything else means "don't build a withdraw".
 */
export type LiquidityRead =
  | { status: "ok"; liquidity: bigint }
  /** The leader's position account no longer exists (closed later): its close event carries the exit. */
  | { status: "missing" }
  /** RPC failure or an unreadable account: unknown, retry later. */
  | { status: "error"; message: string };

export type DammRemoveShare = { ok: true; bps: number } | { ok: false; reason: "ratio_read_failed" | "leader_position_gone"; detail?: string };

export function dammRemoveShare(removed: bigint, left: LiquidityRead): DammRemoveShare {
  if (left.status === "error") return { ok: false, reason: "ratio_read_failed", detail: left.message };
  if (left.status === "missing") return { ok: false, reason: "leader_position_gone" };
  if (removed <= 0n) return { ok: false, reason: "ratio_read_failed", detail: "no liquidity removed" };
  const bps = Number((removed * 10_000n) / (left.liquidity + removed));
  return { ok: true, bps: Math.max(1, Math.min(10_000, bps)) };
}
