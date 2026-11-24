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
 * How we repeat a mirrored move: the leader's own rebalance_liquidity, scaled to
 * our size, in one transaction (as the leader does, with a raised compute limit:
 * Karınca's moves use 0.3–0.7M CU). If that can't be built or fails simulation
 * (nothing sent), the executor falls back to close-and-reopen.
 */
export const REBALANCE_METHOD = "single_rebalance" as const;

import type { RebalanceAdd } from "./strategy.js";

/** A leader "add" segment with signs applied (bit_flag: 1 = x0, 2 = y0, 4 = Δx, 8 = Δy negative). */
export interface SignedAdd {
  minDeltaId: number;
  maxDeltaId: number;
  x0: bigint;
  y0: bigint;
  deltaX: bigint;
  deltaY: bigint;
}

export function signedAdds(adds: RebalanceAdd[]): SignedAdd[] {
  return adds.map((a) => {
    const f = Number(a.bit_flag);
    const s = (v: bigint, bit: number) => ((f & bit) !== 0 ? -BigInt(v) : BigInt(v));
    return { minDeltaId: Number(a.min_delta_id), maxDeltaId: Number(a.max_delta_id), x0: s(a.x0, 1), y0: s(a.y0, 2), deltaX: s(a.delta_x, 4), deltaY: s(a.delta_y, 8) };
  });
}

/**
 * Scale the leader's add segments to our position. Amounts per bin are linear in
 * (base, delta), so scaling both scales the deposit. Each side is scaled by what
 * we actually withdraw over what the leader withdrew on that side (the move is
 * swapless), minus a small haircut so our deposit never exceeds what came out.
 */
export function scaleAdds(adds: SignedAdd[], ours: { x: bigint; y: bigint }, leader: { x: bigint; y: bigint }, haircutBps = 50): SignedAdd[] {
  const keep = BigInt(10_000 - haircutBps);
  const sx = (v: bigint) => (leader.x > 0n ? (v * ours.x * keep) / (leader.x * 10_000n) : 0n);
  const sy = (v: bigint) => (leader.y > 0n ? (v * ours.y * keep) / (leader.y * 10_000n) : 0n);
  return adds.map((a) => ({ ...a, x0: sx(a.x0), deltaX: sx(a.deltaX), y0: sy(a.y0), deltaY: sy(a.deltaY) }));
}
