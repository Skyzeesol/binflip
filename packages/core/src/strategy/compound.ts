import { binPrice } from "./bins.js";

export interface CompoundCheck {
  /** Unclaimed fees on chain, raw units (y = SOL lamports, x = token). */
  feeX: bigint;
  feeY: bigint;
  activeId: number;
  binStep: number;
  lastCompoundAt: Date | null;
  openedAt: Date | null;
  /** copy_settings.compound_interval_minutes; null = auto-compound off. */
  intervalMinutes: number | null;
  /** Don't compound less than this (lamports): each compound costs several tx fees. */
  minLamports: bigint;
  now?: Date;
}

export type CompoundDecision =
  | { do: "wait"; reason: "off" | "interval" | "below_min"; feesValueY: bigint }
  | { do: "compound"; feesValueY: bigint };

/**
 * HawkFi-style auto-compound: on every interval, claim fees and add them back
 * to the position — but only when they are worth more than `minLamports`,
 * so a quiet pool never pays fees to move dust.
 */
export function shouldCompound(c: CompoundCheck): CompoundDecision {
  const feesValueY = c.feeY + BigInt(Math.floor(Number(c.feeX) * binPrice(c.activeId, c.binStep)));
  if (c.intervalMinutes === null || c.intervalMinutes <= 0) return { do: "wait", reason: "off", feesValueY };
  const now = (c.now ?? new Date()).getTime();
  const since = (c.lastCompoundAt ?? c.openedAt)?.getTime() ?? 0;
  if (now - since < c.intervalMinutes * 60_000) return { do: "wait", reason: "interval", feesValueY };
  if (feesValueY < c.minLamports) return { do: "wait", reason: "below_min", feesValueY };
  return { do: "compound", feesValueY };
}

/**
 * Where compounded fees go back in, inside the position's current range:
 * SOL at or below the active bin, token above it. When there are no bins
 * above price, token fees can't be added single-sided and are sold instead.
 */
export function compoundRanges(lower: number, upper: number, activeId: number) {
  const sol = activeId >= lower ? { from: lower, to: Math.min(upper, activeId) } : null;
  const token = upper > activeId ? { from: Math.max(lower, activeId + 1), to: upper } : null;
  return { sol, token };
}
