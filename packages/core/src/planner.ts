import { WSOL_MINT } from "./constants.js";
import type { ActionKind, LeaderAction } from "./meteora/actions.js";
import type { Strategy } from "./meteora/strategy.js";
import { classifyRebalance } from "./meteora/rebalance.js";
import { PPM, mirrorRemoveBps, sizeDeposit, type SizingSettings } from "./sizing.js";

/** Settings the planner needs, a subset of copy_settings + user_risk_settings. */
export interface PlannerSettings {
  sizing: SizingSettings;
  copyDlmmStrategies: Strategy[];
  copyDammV2: boolean;
  memeProtection: boolean;
  leaderPaused: boolean;
  followExitsWhilePaused: boolean;
  killSwitch: boolean;
  fundProtectionTripped: boolean;
  maxSolPerTx: bigint;
  /** Remaining room under maxSolPerDay for opens/adds today. */
  dailyRoom: bigint;
  /**
   * Token price in lamports per raw token unit, from the pool's active bin.
   * Enables value-based Meme Protection and two-sided (zap) copies. null = unknown.
   */
  tokenPriceLamports?: number | null;
  /**
   * Smart Token Retention: tokens of this pool we are holding from a recent exit.
   * A re-add uses them instead of buying, and Meme Protection lets it through.
   */
  heldTokens?: bigint;
}

/** LP Agent Meme Protection: skip when more than this share of the deposit would be the untrusted token. */
export const MEME_MAX_UNTRUSTED_BPS = 9_500;

/** Our mirrored position for the leader position, if we hold one. */
export interface OurPosition {
  id: string;
  state: string;
  depositedSol: bigint;
  ratioPpm: bigint | null;
  fundedAt: Date | null;
  lowerBinId: number | null;
  upperBinId: number | null;
}

export type SkipReason =
  | "kill_switch"
  | "fund_protection"
  | "leader_paused"
  | "leader_position_gone"
  /** A remove whose bins/share could not be read from the leader's tx: never guessed as 100%. */
  | "remove_unresolved"
  /** The leader emptied bins our copy doesn't have. */
  | "remove_outside_copy"
  | "pool_type_not_copied"
  | "strategy_not_copied"
  | "position_not_copied"
  | "already_closed"
  | "non_sol_pair"
  | "meme_protection"
  | "daily_limit"
  | "copy_size_zero"
  | "no_sizing_rule"
  | "position_cap_reached"
  | "rebalance_partial"
  | "rebalance_topup"
  | "rebalance_take_profit"
  | "rebalance_unknown"
  // live-only, decided by the executor with chain state
  | "low_balance"
  | "token_filter"
  | "token_blacklisted"
  | "damm_live_not_supported";

export type Plan =
  | { do: "skip"; kind: ActionKind; reason: SkipReason }
  /** swapSol: part of amountSol to swap into the token first, so our deposit has the leader's ratio (LP Agent zap). */
  | { do: "open"; amountSol: bigint; ratioPpm: bigint | null; capped: string | null; empty: boolean; swapSol?: bigint; tokenFromHold?: bigint; heldValue?: bigint }
  | { do: "add"; amountSol: bigint; ratioPpm: bigint; capped: string | null; firstFunding: boolean; swapSol?: bigint; tokenFromHold?: bigint; heldValue?: bigint }
  /**
   * bps applies to the whole position when `ranges` is absent (an explicit full-range remove);
   * with `ranges`, only those bins are touched, each with its own share.
   */
  | { do: "remove"; bps: number; ranges?: Array<{ fromBinId: number; toBinId: number; bps: number }> }
  | { do: "close" }
  | { do: "claim" }
  /** Repeat the leader's full move: same withdrawals, same new range and shape, scaled to us. */
  /** full = the whole old range moved (close-and-reopen is a valid fallback); otherwise only the exact instruction fits. */
  | { do: "rebalance"; full: boolean };

const EXITS: ReadonlySet<ActionKind> = new Set(["remove", "close", "claim"]);

/** SOL amount the leader put in, from the WSOL side of the pair. */
export function leaderSolSide(a: LeaderAction): { sol: bigint; token: bigint } | null {
  if (a.mintY === WSOL_MINT) return { sol: a.added.y, token: a.added.x };
  if (a.mintX === WSOL_MINT) return { sol: a.added.x, token: a.added.y };
  return null;
}

/**
 * Decide what we do for one leader action. Pure: all state comes in as input.
 * Exits are allowed through pause/kill-switch only where the settings say so,
 * so a stop never strands an open copy (LP Agent: exits keep following leaders).
 */
export function planCopy(a: LeaderAction, s: PlannerSettings, ours: OurPosition | null): Plan {
  const isExit = EXITS.has(a.kind);
  const skip = (reason: SkipReason): Plan => ({ do: "skip", kind: a.kind, reason });

  if (s.killSwitch && !isExit) return skip("kill_switch");
  if (s.leaderPaused && !(isExit && s.followExitsWhilePaused)) return skip("leader_paused");
  if (s.fundProtectionTripped && !isExit) return skip("fund_protection");
  if (a.protocol === "damm_v2" && !s.copyDammV2) return skip("pool_type_not_copied");

  if (isExit || a.kind === "rebalance") {
    if (!ours) return skip("position_not_copied");
    if (ours.state === "CLOSED") return skip("already_closed");
    if (a.kind === "close") return { do: "close" };
    if (a.kind === "claim") return { do: "claim" };
    if (a.kind === "rebalance") {
      // Like the leader: every rebalance_liquidity is repeated as the same instruction, scaled to us
      // (partial moves and moves that take profit too). A move that tops up needs extra SOL from the
      // wallet beyond what came out, so it stays skipped (LP Agent skips it as well).
      const c = classifyRebalance(a);
      if (c.ok) return { do: "rebalance", full: true };
      if (c.reason === "rebalance_partial" || c.reason === "rebalance_take_profit") return { do: "rebalance", full: false };
      return skip(c.reason);
    }
    return planRemove(a, ours, skip);
  }

  // open / add
  if (a.protocol === "dlmm" && a.strategy && !s.copyDlmmStrategies.includes(a.strategy)) {
    return skip("strategy_not_copied");
  }
  if (a.kind === "add" && !ours) return skip("position_not_copied");

  const side = leaderSolSide(a);
  const funded = side !== null && (side.sol > 0n || side.token > 0n);

  if (a.kind === "open" && !funded) {
    // Leader opened an empty position to fund it a moment later; mirror the empty open.
    return { do: "open", amountSol: 0n, ratioPpm: null, capped: null, empty: true };
  }
  if (!side) return skip("non_sol_pair");

  // Value both sides in SOL when we know the price (LP Agent sizes and protects on value, and zaps).
  const price = s.tokenPriceLamports ?? null;
  const tokenValue = price !== null && side.token > 0n ? BigInt(Math.floor(Number(side.token) * price)) : 0n;
  const leaderValue = side.sol + tokenValue;
  const held = s.heldTokens ?? 0n;
  const reusingHeld = held > 0n && side.token > 0n;
  // LP Agent: "If the leader adds it back within your hold time, your copy puts the kept token back,
  // and Meme Protection lets that re-add through."
  if (s.memeProtection && !reusingHeld) {
    const untrustedBps = leaderValue > 0n ? Number((tokenValue * 10_000n) / leaderValue) : 0;
    if ((side.sol === 0n && side.token > 0n) || untrustedBps > MEME_MAX_UNTRUSTED_BPS) return skip("meme_protection");
  }

  const sized = sizeDeposit(leaderValue, s.sizing, {
    ratioPpm: ours?.ratioPpm ?? null,
    depositedSol: ours?.depositedSol ?? 0n,
    fundedAt: ours?.fundedAt ?? null,
  });
  if (!sized.ok) return skip(sized.reason);

  let amount = sized.amount;
  let ratioPpm = sized.ratioPpm;
  let capped: string | null = sized.capped;
  const firstFunding = (ours?.depositedSol ?? 0n) === 0n;
  if (amount > s.maxSolPerTx) {
    amount = s.maxSolPerTx;
    capped = "max_sol_per_tx";
    // Same rule as a capped open: later adds keep the smaller share we actually got.
    if (firstFunding) ratioPpm = (amount * PPM) / leaderValue;
  }
  if (amount > s.dailyRoom) return skip("daily_limit");

  // Zap: swap the token's share of our SOL into the token, so we deposit in the leader's ratio.
  let swapSol = tokenValue > 0n ? (amount * tokenValue) / leaderValue : 0n;
  let amountSol = amount;
  let tokenFromHold = 0n;
  let heldValue = 0n;
  if (reusingHeld && price !== null && price > 0) {
    // Our share of the leader's token comes from what we kept, not from a new buy — but only up to the
    // token part of the (capped) budget: swapSol is that part in lamports. Without a price we can't
    // value the token, so nothing held is reused.
    const byRatio = (side.token * ratioPpm) / PPM;
    const byBudget = BigInt(Math.floor(Number(swapSol) / price));
    const wanted = byRatio < byBudget ? byRatio : byBudget;
    tokenFromHold = held < wanted ? held : wanted;
    const covered = BigInt(Math.floor(Number(tokenFromHold) * price));
    heldValue = covered < swapSol ? covered : swapSol;
    swapSol -= heldValue;
    amountSol -= heldValue;
  }
  // New SOL spent (amountSol, incl. swapSol) and the value of reused token (heldValue) are kept apart;
  // together they never exceed the capped amount.
  const extra = { ...(swapSol > 0n ? { swapSol } : {}), ...(tokenFromHold > 0n ? { tokenFromHold, heldValue } : {}) };
  if (a.kind === "open") return { do: "open", amountSol, ratioPpm, capped, empty: false, ...extra };
  return { do: "add", amountSol, ratioPpm, capped, firstFunding, ...extra };
}

/**
 * A leader remove mirrored on our copy, keeping WHICH bins the leader emptied:
 * - an unbounded range (remove_all, DAMM V2 share) applies to the whole position;
 * - bounded ranges stay ranges, clipped to our copy's bins, each with its own bps;
 * - nothing readable → skip (a remove we can't read is never turned into a full withdraw).
 */
function planRemove(a: LeaderAction, ours: OurPosition, skip: (r: SkipReason) => Plan): Plan {
  const rs = a.removeRanges.filter((r) => r.bps > 0);
  if (!rs.length) return skip("remove_unresolved");
  const whole = rs.filter((r) => r.minBinId === null || r.maxBinId === null);
  if (whole.length) return { do: "remove", bps: mirrorRemoveBps(Math.max(...whole.map((r) => r.bps))) };

  const lo = ours.lowerBinId, hi = ours.upperBinId;
  const ranges = rs
    .map((r) => ({ fromBinId: Math.max(r.minBinId!, lo ?? r.minBinId!), toBinId: Math.min(r.maxBinId!, hi ?? r.maxBinId!), bps: mirrorRemoveBps(r.bps) }))
    .filter((r) => r.fromBinId <= r.toBinId && r.bps > 0)
    .sort((x, y) => x.fromBinId - y.fromBinId);
  if (!ranges.length) return skip("remove_outside_copy");
  // The leader emptied every bin our copy has: the same as an explicit full remove.
  if (lo !== null && hi !== null && ranges.every((r) => r.bps === 10_000) && covers(ranges, lo, hi)) return { do: "remove", bps: 10_000 };
  return { do: "remove", bps: Math.max(...ranges.map((r) => r.bps)), ranges };
}

function covers(ranges: Array<{ fromBinId: number; toBinId: number }>, lo: number, hi: number): boolean {
  let next = lo;
  for (const r of ranges) {
    if (r.fromBinId > next) return false;
    next = Math.max(next, r.toBinId + 1);
  }
  return next > hi;
}
