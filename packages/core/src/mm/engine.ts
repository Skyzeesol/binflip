/**
 * İlginç (BviQ) market-making engine — the mechanical rules recovered from 91k
 * transactions (research/ilginc/FINDINGS.md). Pure functions, no I/O.
 *
 *  - width    w = max(1, round(100 / binStep))        (68,274 / 68,274 rebalances)
 *  - placement SOL  → [active − w, active − 1]
 *              token → [active + 1, active + w]       (never on the active bin)
 *  - trigger  active bin ≥ 2 bins outside the range   (none at distance 1)
 *  - side     price escaped UP   → the bins were not crossed, still SOL  → SOL below
 *             price escaped DOWN → the bins were crossed, now token      → token above
 *             (up→SOL 12,177/12,177, down→token 11,652/11,652)
 */

export const MM_TRIGGER_BINS = 2;

/**
 * Idle exit: close a position after ~55 min without a rebalance. From 1,602 closed BviQ
 * positions: closes cluster at 55–65 min since the last move, almost none at 5–50 min, and
 * never-moved positions close at 54–61 min (research/ilginc/FINDINGS.md, 28 Nov).
 */
export const MM_IDLE_EXIT_SEC = 55 * 60;

export function mmIdleExpired(lastMoveAt: number, now: number, idleSec = MM_IDLE_EXIT_SEC): boolean {
  return now - lastMoveAt >= idleSec;
}

export type MmSide = "sol" | "token";

export interface MmRange {
  lower: number;
  upper: number;
  side: MmSide;
}

/** Bins per position: about 1% of price. JS Math.round rounds .5 up (bin step 8 → 13), matching the data. */
export function mmWidth(binStep: number): number {
  if (!(binStep > 0)) throw new Error(`invalid bin step ${binStep}`);
  return Math.max(1, Math.round(100 / binStep));
}

/** Where a position of `side` goes next to `active`. */
export function mmPlace(side: MmSide, active: number, binStep: number): MmRange {
  const w = mmWidth(binStep);
  return side === "sol"
    ? { lower: active - w, upper: active - 1, side }
    : { lower: active + 1, upper: active + w, side };
}

/** Signed distance of the active bin from the range: >0 above, <0 below, 0 inside. */
export function mmDistance(range: Pick<MmRange, "lower" | "upper">, active: number): number {
  if (active > range.upper) return active - range.upper;
  if (active < range.lower) return active - range.lower;
  return 0;
}

export type MmDecision =
  | { kind: "hold"; distance: number }
  | { kind: "rebalance"; distance: number; next: MmRange };

/**
 * Hold while the active bin is within `trigger − 1` bins of the range; once it is
 * `trigger` or more bins away, move the whole position next to the active bin on
 * the side implied by the direction of the escape.
 */
export function mmDecide(range: MmRange, active: number, binStep: number, trigger = MM_TRIGGER_BINS): MmDecision {
  const distance = mmDistance(range, active);
  if (Math.abs(distance) < trigger) return { kind: "hold", distance };
  const side: MmSide = distance > 0 ? "sol" : "token";
  return { kind: "rebalance", distance, next: mmPlace(side, active, binStep) };
}

export function sameRange(a: Pick<MmRange, "lower" | "upper">, b: Pick<MmRange, "lower" | "upper">): boolean {
  return a.lower === b.lower && a.upper === b.upper;
}
