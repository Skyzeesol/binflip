import { mmWidth, type MmRange } from "./engine.js";

/** One rebalance_liquidity add segment, relative to the active bin (SDK / IDL shape). */
export interface MmAdd {
  minDeltaId: number;
  maxDeltaId: number;
  x0: bigint;
  y0: bigint;
  deltaX: bigint;
  deltaY: bigint;
}

/** Share of the withdrawn amounts put back on each rebalance. */
export const MM_REDEPOSIT_KEEP = 0.999;

/** Price of bin `id`: lamports per raw token unit. */
export const mmBinPrice = (binStep: number, id: number): number => Math.pow(1 + binStep / 1e4, id);

/**
 * The adds that put what we hold back next to the active bin, flat (delta 0), like BviQ:
 *  - SOL  y → [active − w, active − 1], y0 = y / w lamports per bin
 *  - token x → [active + 1, active + w], x0 in Y units per bin: the program deposits x0 / price(b)
 *    tokens in bin b (checked on 3,000 BviQ moves: Σ x0/price(b) = deposited tokens, exactly).
 *    So x0 = x / Σ(1/price(b)) spends all the tokens without exceeding them.
 * Both sides are present only when a position held both (rare: the 2-bin trigger means a
 * position is normally fully on one side).
 */
export function mmAdds(x: bigint, y: bigint, binStep: number): MmAdd[] {
  const w = mmWidth(binStep);
  const out: MmAdd[] = [];
  if (y > 0n) out.push({ minDeltaId: -w, maxDeltaId: -1, x0: 0n, y0: y / BigInt(w), deltaX: 0n, deltaY: 0n });
  if (x > 0n) {
    // Relative ids 1..w; using price(d) relative to the active bin and dividing by price(active)
    // would be the same thing, so compute Σ 1/price over the absolute bins via the relative ratio.
    let invSum = 0;
    for (let d = 1; d <= w; d++) invSum += 1 / mmBinPrice(binStep, d);
    // x0 is in Y units of the ABSOLUTE bin prices; callers pass the active bin to scale.
    out.push({ minDeltaId: 1, maxDeltaId: w, x0: BigInt(Math.floor(Number(x) / invSum)), y0: 0n, deltaX: 0n, deltaY: 0n });
  }
  return out;
}

/**
 * Token-side x0 must be in Y units at the real bin prices: scale the relative result by
 * price(active). Kept separate so the relative math above stays exact and testable.
 */
export function mmAddsAt(x: bigint, y: bigint, binStep: number, active: number, keep = MM_REDEPOSIT_KEEP): MmAdd[] {
  // Re-deposit slightly less than withdrawn: with max_deposit = 0 (as BviQ sends it) the program
  // rejects a deposit above the withdrawal (6003); the remainder stays in the wallet.
  const k = BigInt(Math.round(keep * 1e6));
  x = (x * k) / 1_000_000n;
  y = (y * k) / 1_000_000n;
  const pActive = mmBinPrice(binStep, active);
  // 1e-6 haircut: float precision on very large raw amounts must never ask for more tokens than we hold.
  return mmAdds(x, y, binStep).map((a) => (a.x0 > 0n ? { ...a, x0: BigInt(Math.floor(Number(a.x0) * pActive * (1 - 1e-6))) } : a));
}

/** The range our position covers after these adds. */
export function mmRangeAfter(adds: MmAdd[], active: number): MmRange {
  const lower = Math.min(...adds.map((a) => active + a.minDeltaId));
  const upper = Math.max(...adds.map((a) => active + a.maxDeltaId));
  const side = adds.every((a) => a.y0 > 0n) ? "sol" : adds.every((a) => a.x0 > 0n) ? "token" : upper > active ? "token" : "sol";
  return { lower, upper, side };
}

/** Tokens the program would deposit for these adds (for checks: must not exceed what we hold). */
export function mmTokensDeposited(adds: MmAdd[], binStep: number, active: number): number {
  let t = 0;
  for (const a of adds) for (let d = a.minDeltaId; d <= a.maxDeltaId; d++) t += Number(a.x0) / mmBinPrice(binStep, active + d);
  return t;
}
