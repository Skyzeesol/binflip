import type { Bin } from "./bins.js";

/**
 * Precision Hybrid (HawkFi): 50% Spot + 50% Bid-Ask around the active bin, kept
 * there by Reshape Liquidity (RL): the range stays fixed; when the active bin has
 * moved `reshapeBins` (1–51) since the last shape, the liquidity is redistributed
 * around the new price. Swapless: SOL goes back below/at the price, the token above.
 *
 * Per side with n bins ordered from the price outward (i = 0..n-1), total T:
 *   spot half:    T/2 · 1/n
 *   bid-ask half: T/2 · (i+1) / (n(n+1)/2)
 *   amount(i) = T/(2n) + T(i+1)/(n(n+1))  →  base + step·i
 * which is exactly the "base + delta·|distance|" form rebalance_liquidity takes.
 */
export const DEFAULT_RESHAPE_BINS = 12;

export function reshapeBinsFrom(p: Record<string, unknown> | null | undefined): number {
  const v = p?.reshapeBins;
  return typeof v === "number" && Number.isFinite(v) ? Math.min(51, Math.max(1, Math.round(v))) : DEFAULT_RESHAPE_BINS;
}

/** One rebalance_liquidity tx: 70 bins measured at ~527k CU, so ~160 bins stays under the 1.4M limit. */
export const MAX_RESHAPE_BINS = 160;

/** RL triggers inside the range only, once the price moved far enough from where it was last shaped. */
export function shouldReshape(active: number, lastShapedActive: number, lower: number, upper: number, bins: number): boolean {
  if (upper - lower + 1 > MAX_RESHAPE_BINS) return false;
  return active >= lower && active <= upper && Math.abs(active - lastShapedActive) >= bins;
}

/** amount(i) = base + step·i over n bins summing to `total` (integer lamports / raw units). */
export function hybridLine(total: bigint, n: number): { base: bigint; step: bigint } {
  if (n <= 0 || total <= 0n) return { base: 0n, step: 0n };
  const N = BigInt(n);
  const step = total / (N * (N + 1n));
  const base = total / (2n * N) + step;
  return { base, step };
}

export interface HybridAdd {
  minDeltaId: number;
  maxDeltaId: number;
  x0: bigint;
  y0: bigint;
  deltaX: bigint;
  deltaY: bigint;
}

/**
 * rebalance_liquidity add segments (deltas relative to the active bin) for the hybrid
 * shape on [lower, upper]: SOL on [lower .. active], token on [active+1 .. upper].
 * The program computes amount = base + Δ·|d| per bin; the base is shifted by the
 * distance of the nearest bin.
 *
 * Units (verified in mainnet simulation): the Y side is raw SOL, but the X side is a
 * VALUE in Y that the program divides by each bin's price. So the token total is
 * turned into value at the active price; bins above it are pricier, so the tokens
 * this needs never exceed what we hold.
 */
export function hybridAdds(lower: number, upper: number, active: number, totals: { x: bigint; y: bigint }, binStep: number): HybridAdd[] {
  const adds: HybridAdd[] = [];
  const yFrom = lower - active;
  const yTo = Math.min(0, upper - active);
  if (totals.y > 0n && yFrom <= yTo) {
    const n = yTo - yFrom + 1;
    const { base, step } = hybridLine(totals.y, n);
    const near = BigInt(Math.abs(yTo)); // |d| of the bin closest to price
    adds.push({ minDeltaId: yFrom, maxDeltaId: yTo, x0: 0n, deltaX: 0n, y0: base - step * near, deltaY: step });
  }
  const xFrom = Math.max(1, lower - active);
  const xTo = upper - active;
  const xValue = BigInt(Math.floor(Number(totals.x) * Math.pow(1 + binStep / 10_000, active)));
  if (xValue > 0n && xFrom <= xTo) {
    const n = xTo - xFrom + 1;
    const { base, step } = hybridLine(xValue, n);
    const near = BigInt(xFrom);
    adds.push({ minDeltaId: xFrom, maxDeltaId: xTo, y0: 0n, deltaY: 0n, x0: base - step * near, deltaX: step });
  }
  return adds;
}

/** The same shape as virtual bins (dry-run model): token per bin = value / bin price. */
export function hybridBins(lower: number, upper: number, active: number, totals: { x: number; y: number }, binStep: number): Bin[] {
  const out = new Map<number, Bin>();
  const put = (id: number, x: number, y: number) => {
    const b = out.get(id) ?? { id, x: 0, y: 0 };
    out.set(id, { id, x: b.x + x, y: b.y + y });
  };
  const px = (id: number) => Math.pow(1 + binStep / 10_000, id);
  for (const a of hybridAdds(lower, upper, active, { x: BigInt(Math.floor(totals.x)), y: BigInt(Math.floor(totals.y)) }, binStep)) {
    for (let d = a.minDeltaId; d <= a.maxDeltaId; d++) {
      const k = BigInt(Math.abs(d));
      put(active + d, Number(a.x0 + a.deltaX * k) / px(active + d), Number(a.y0 + a.deltaY * k));
    }
  }
  return [...out.values()].filter((b) => b.x > 0 || b.y > 0).sort((a, b) => a.id - b.id);
}
