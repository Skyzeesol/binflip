export type Strategy = "spot" | "curve" | "bid_ask" | "custom";

/** Anchor decodes enums as { VariantName: {} }. */
export function strategyFromType(t: unknown): Strategy | null {
  const name = t && typeof t === "object" ? Object.keys(t)[0] : typeof t === "string" ? t : null;
  if (!name) return null;
  if (/^spot/i.test(name)) return "spot";
  if (/^curve/i.test(name)) return "curve";
  if (/^bidask/i.test(name)) return "bid_ask";
  return "custom";
}

export interface RebalanceAdd {
  min_delta_id: number;
  max_delta_id: number;
  x0: bigint;
  y0: bigint;
  delta_x: bigint;
  delta_y: bigint;
  bit_flag: number;
}

/**
 * Infer the liquidity shape from rebalance_liquidity "adds".
 * Per the SDK's strategy builders (amount(bin) = base + delta * distance):
 *   Spot   → delta = 0
 *   Curve  → delta < 0 (bit 4 for x, bit 8 for y): less liquidity away from price
 *   BidAsk → delta > 0: more liquidity away from price
 * Segments that disagree → "custom".
 */
export function classifyRebalanceAdds(adds: RebalanceAdd[]): Strategy {
  const shapes = new Set<Strategy>();
  for (const a of adds) {
    const flag = Number(a.bit_flag);
    const sides: Array<{ base: bigint; delta: bigint; neg: boolean }> = [
      { base: BigInt(a.x0), delta: BigInt(a.delta_x), neg: (flag & 4) !== 0 },
      { base: BigInt(a.y0), delta: BigInt(a.delta_y), neg: (flag & 8) !== 0 },
    ];
    for (const s of sides) {
      if (s.base === 0n && s.delta === 0n) continue; // side not used
      if (s.delta === 0n) shapes.add("spot");
      else shapes.add(s.neg ? "curve" : "bid_ask");
    }
  }
  if (shapes.size === 1) return [...shapes][0]!;
  return "custom";
}
