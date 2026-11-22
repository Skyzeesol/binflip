import { CAPPED_SHARE_LOCK_DAYS } from "./constants.js";

/** Ratios are parts-per-million so small shares (e.g. 0.7%) keep precision. */
export const PPM = 1_000_000n;

export interface SizingSettings {
  mode: "percent_of_leader" | "fixed_sol";
  /** Copy percentage in bps (5000 = 50%). LP Agent allows 1%–10000%. */
  percentBps: number | null;
  fixedSol: bigint | null;
  /** "Max Increase Amount per Tx": cap on every copied open and add. */
  maxPerAdd: bigint | null;
  /** Our extra: hard cap on total deposited per position. */
  maxPerPosition: bigint | null;
}

export interface PositionSizingState {
  /** Share fixed when the position was first funded, in ppm of the leader. */
  ratioPpm: bigint | null;
  depositedSol: bigint;
  fundedAt: Date | null;
}

export type SizeResult =
  | { ok: true; amount: bigint; ratioPpm: bigint; capped: "max_per_add" | "max_per_position" | null }
  | { ok: false; reason: "copy_size_zero" | "no_sizing_rule" | "position_cap_reached" };

/**
 * Size a copied deposit (first funding or a later add) from the leader's SOL amount.
 *
 * Rules (LP Agent docs, "How sizing works"):
 * - First funding: leader × Copy %, capped by Max per tx. With only a Max, copy
 *   the leader's amount up to the Max. Fixed-SOL mode deposits the fixed amount.
 * - If the cap cut the first funding short, later adds use that smaller share
 *   for CAPPED_SHARE_LOCK_DAYS, never more than the current Copy %.
 * - Every add is capped by Max per tx; our maxPerPosition caps the running total.
 */
export function sizeDeposit(
  leaderSol: bigint,
  s: SizingSettings,
  pos: PositionSizingState,
  now: Date = new Date(),
): SizeResult {
  if (leaderSol <= 0n) return { ok: false, reason: "copy_size_zero" };

  const pctPpm = s.percentBps !== null ? (BigInt(s.percentBps) * PPM) / 10_000n : null;
  const firstFunding = pos.depositedSol === 0n || pos.ratioPpm === null;

  let ratioPpm: bigint;
  if (firstFunding) {
    if (s.mode === "fixed_sol") {
      if (!s.fixedSol || s.fixedSol <= 0n) return { ok: false, reason: "no_sizing_rule" };
      ratioPpm = (s.fixedSol * PPM) / leaderSol;
    } else if (pctPpm !== null) {
      ratioPpm = pctPpm;
    } else if (s.maxPerAdd !== null) {
      ratioPpm = PPM; // match the leader, the cap applies below
    } else {
      return { ok: false, reason: "no_sizing_rule" };
    }
  } else {
    const locked = pos.ratioPpm!;
    const lockActive =
      pos.fundedAt !== null && now.getTime() - pos.fundedAt.getTime() < CAPPED_SHARE_LOCK_DAYS * 86_400_000;
    const current = pctPpm ?? locked;
    ratioPpm = lockActive ? min(locked, current) : current;
  }

  let amount = (leaderSol * ratioPpm) / PPM;
  let capped: "max_per_add" | "max_per_position" | null = null;

  if (s.maxPerAdd !== null && amount > s.maxPerAdd) {
    amount = s.maxPerAdd;
    capped = "max_per_add";
  }
  if (s.maxPerPosition !== null) {
    const room = s.maxPerPosition - pos.depositedSol;
    if (room <= 0n) return { ok: false, reason: "position_cap_reached" };
    if (amount > room) {
      amount = room;
      capped = "max_per_position";
    }
  }
  if (amount <= 0n) return { ok: false, reason: "copy_size_zero" };

  // On first funding the effective share is what we actually deposited.
  const effective = firstFunding ? (amount * PPM) / leaderSol : ratioPpm;
  return { ok: true, amount, ratioPpm: effective, capped };
}

/** Our share of a leader removal: same bps of our position. Never capped. */
export function mirrorRemoveBps(leaderBps: number): number {
  return Math.max(0, Math.min(10_000, Math.round(leaderBps)));
}

/** LP Agent's suggestion: our net worth ÷ leader's, as bps (min 1%). */
export function suggestedPercentBps(ourNetWorth: bigint, leaderNetWorth: bigint): number {
  if (leaderNetWorth <= 0n) return 10_000;
  const bps = Number((ourNetWorth * 10_000n) / leaderNetWorth);
  return Math.max(100, Math.min(1_000_000, bps));
}

const min = (a: bigint, b: bigint) => (a < b ? a : b);
