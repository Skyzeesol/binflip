/**
 * LP Agent "Create a Position" range presets → DLMM bin ids.
 * ±5% / ±10% bracket the price; -50% / -70% put the whole range below it (SOL only).
 * price(bin) = (1 + binStep/10000)^bin, so a price ratio r spans log(r)/log(f) bins.
 */
export const MAX_POSITION_BINS = 1400;

export interface BinRange {
  lower: number;
  upper: number;
  bins: number;
  /** Share of the range above the active bin (needs the token side). */
  tokenShare: number;
}

export function binsForRange(activeId: number, binStep: number, lowerPct: number, upperPct: number): BinRange {
  if (!(binStep > 0)) throw new Error("bad bin step");
  if (lowerPct >= upperPct) throw new Error("lower must be below upper");
  if (lowerPct <= -100) throw new Error("lower must be above -100%");
  const f = Math.log(1 + binStep / 10_000);
  const lower = activeId + Math.floor(Math.log(1 + lowerPct / 100) / f);
  // A range that ends at the price keeps the active bin (SOL can sit there); above it, round up.
  const upper = upperPct <= 0 ? activeId + Math.min(0, Math.ceil(Math.log(1 + upperPct / 100) / f)) : activeId + Math.ceil(Math.log(1 + upperPct / 100) / f);
  const bins = upper - lower + 1;
  if (bins > MAX_POSITION_BINS) throw new Error(`range is ${bins} bins; the most a position can hold is ${MAX_POSITION_BINS}`);
  const above = Math.max(0, upper - Math.max(activeId, lower - 1));
  return { lower, upper, bins, tokenShare: upper <= activeId ? 0 : Math.min(1, above / bins) };
}
