import type { LeaderAction } from "./actions.js";

/**
 * LP Agent: "Rebalances: moves your copy the same way. Some rebalances can't be
 * mirrored: the leader moves only part of a position, or takes profit or tops
 * up in the same move. Those are skipped." We implement exactly that rule.
 *
 * Rebalances are swapless, so each side is compared on its own: what the
 * leader put back vs what it took out, with a small tolerance for fees and
 * rounding.
 */
export const REBALANCE_TOLERANCE_BPS = 300; // ±3%

export type RebalanceClass =
  | { ok: true }
  | { ok: false; reason: "rebalance_partial" | "rebalance_topup" | "rebalance_take_profit" | "rebalance_unknown" };

export function classifyRebalance(a: LeaderAction): RebalanceClass {
  const r = a.rebalance;
  if (!r || !r.adds.length) return { ok: false, reason: "rebalance_unknown" };

  // Partial: something other than a full withdrawal of the whole old range.
  const full = a.removeRanges.some(
    (x) => x.bps >= 10_000 && (x.minBinId === null || x.minBinId <= r.oldMin) && (x.maxBinId === null || x.maxBinId >= r.oldMax),
  );
  if (!full) return { ok: false, reason: "rebalance_partial" };

  const tol = (v: bigint) => (v * BigInt(REBALANCE_TOLERANCE_BPS)) / 10_000n + 1n;
  const up = (added: bigint, removed: bigint) => added > removed + tol(removed);
  const down = (added: bigint, removed: bigint) => added + tol(removed) < removed;

  if (up(a.added.x, a.removed.x) || up(a.added.y, a.removed.y)) return { ok: false, reason: "rebalance_topup" };
  const xDown = a.removed.x > 0n ? down(a.added.x, a.removed.x) : false;
  const yDown = a.removed.y > 0n ? down(a.added.y, a.removed.y) : false;
  if ((xDown || a.removed.x === 0n) && (yDown || a.removed.y === 0n) && (xDown || yDown)) {
    return { ok: false, reason: "rebalance_take_profit" };
  }
  return { ok: true };
}

/**
 * How we repeat a mirrored move. A single rebalance_liquidity over a wide
 * position (Karınca: 348 bins) exceeds the compute budget and the SDK does not
 * chunk it, so we move in proven steps instead: remove 100% and close the old
 * position (chunked), open a new one on the leader's new range with the SOL in
 * the leader's shape, and put the token above price in the new range (sold
 * back to SOL when the new range has no bins above price).
 */
export const REBALANCE_METHOD = "close_and_reopen" as const;
