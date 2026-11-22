/** Lamports kept back so the sweep transfer itself can pay its fee. */
export const SWEEP_FEE_BUFFER = 50_000n;

/**
 * How much to send to the main wallet: everything above `keep`, but only once
 * the excess reaches `min` (so we don't pay a fee to move dust). null = nothing to do.
 */
export function sweepAmount(balance: bigint, keep: bigint, min: bigint): bigint | null {
  const excess = balance - keep - SWEEP_FEE_BUFFER;
  if (excess <= 0n || excess < min) return null;
  return excess;
}
