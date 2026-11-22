/**
 * Bin-level model of a single-sided DLMM position, in raw token units.
 *
 * Convention: SOL is the quote token "y", the other token is "x".
 * price(bin) = (1 + binStep/10_000)^binId  → raw y per raw x (DLMM's own definition).
 * Bins below the active bin can only hold y, bins above only x, the active bin both.
 * As the price falls through a bin, its y is bought into x at that bin's price
 * (that is the "bid" filling); as it rises back, x is sold into y.
 *
 * This is the same idea dlmmsim.xyz uses. Fees are ignored here; they are
 * tracked separately from claims.
 */
export interface Bin {
  id: number;
  x: number;
  y: number;
}

export type Shape = "spot" | "curve" | "bid_ask";

export const binPrice = (id: number, binStep: number) => Math.pow(1 + binStep / 10_000, id);

/** Bins needed for the price to fall by `dropBps` (e.g. 1400 = 14%). */
export function binsForDrop(dropBps: number, binStep: number): number {
  return Math.ceil(Math.log(1 / (1 - dropBps / 10_000)) / Math.log(1 + binStep / 10_000));
}

/** Price change in bps when the active bin moves from `from` to `to` (negative = drop). */
export function moveBps(from: number, to: number, binStep: number): number {
  return Math.round((binPrice(to, binStep) / binPrice(from, binStep) - 1) * 10_000);
}

/**
 * Weights for `n` bins ordered from nearest-to-price to farthest.
 * Spot: equal. Bid-ask: grows away from price. Curve: shrinks away from price.
 */
export function shapeWeights(n: number, shape: Shape): number[] {
  return Array.from({ length: n }, (_, i) => (shape === "spot" ? 1 : shape === "bid_ask" ? i + 1 : n - i));
}

/**
 * Spread `amount` over bins [from..to]. `nearId` is the bin closest to price
 * (the top for a SOL bid below price, the bottom for a token ask above it).
 */
export function distribute(
  amount: number,
  from: number,
  to: number,
  shape: Shape,
  side: "x" | "y",
  nearId: number,
): Bin[] {
  if (to < from || amount <= 0) return [];
  const ids = Array.from({ length: to - from + 1 }, (_, i) => from + i).sort(
    (a, b) => Math.abs(a - nearId) - Math.abs(b - nearId),
  );
  const w = shapeWeights(ids.length, shape);
  const total = w.reduce((s, v) => s + v, 0);
  return ids
    .map((id, i) => ({ id, x: side === "x" ? (amount * w[i]!) / total : 0, y: side === "y" ? (amount * w[i]!) / total : 0 }))
    .sort((a, b) => a.id - b.id);
}

/** Move the active bin and convert every bin the price crossed. Returns new bins. */
export function applyMove(bins: Bin[], from: number, to: number, binStep: number): Bin[] {
  return bins.map((b) => {
    const p = binPrice(b.id, binStep);
    // Price fell through this bin: its SOL got spent buying token.
    if (to < from && b.id <= from && b.id > to && b.y > 0) return { id: b.id, x: b.x + b.y / p, y: 0 };
    // Price rose through this bin: its token got sold for SOL.
    if (to > from && b.id >= from && b.id < to && b.x > 0) return { id: b.id, x: 0, y: b.y + b.x * p };
    return { ...b };
  });
}

/** Position value in raw y (SOL lamports) at the active bin's price. */
export function valueInY(bins: Bin[], activeId: number, binStep: number): number {
  const p = binPrice(activeId, binStep);
  return bins.reduce((s, b) => s + b.y + b.x * p, 0);
}

export const totalX = (bins: Bin[]) => bins.reduce((s, b) => s + b.x, 0);
export const totalY = (bins: Bin[]) => bins.reduce((s, b) => s + b.y, 0);

/** Merge two bin lists, summing amounts per bin id. */
export function mergeBins(a: Bin[], b: Bin[]): Bin[] {
  const m = new Map<number, Bin>();
  for (const bin of [...a, ...b]) {
    const cur = m.get(bin.id) ?? { id: bin.id, x: 0, y: 0 };
    m.set(bin.id, { id: bin.id, x: cur.x + bin.x, y: cur.y + bin.y });
  }
  return [...m.values()].filter((v) => v.x > 0 || v.y > 0).sort((p, q) => p.id - q.id);
}
