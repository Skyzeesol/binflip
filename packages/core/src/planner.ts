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
}

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
  | "damm_live_not_supported";

export type Plan =
  | { do: "skip"; kind: ActionKind; reason: SkipReason }
  | { do: "open"; amountSol: bigint; ratioPpm: bigint | null; capped: string | null; empty: boolean }
  | { do: "add"; amountSol: bigint; ratioPpm: bigint; capped: string | null; firstFunding: boolean }
  | { do: "remove"; bps: number }
  | { do: "close" }
  | { do: "claim" }
  /** Repeat the leader's full move: same withdrawals, same new range and shape, scaled to us. */
  | { do: "rebalance" };

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
      const c = classifyRebalance(a);
      return c.ok ? { do: "rebalance" } : skip(c.reason);
    }
    const full = a.removeRanges.some((r) => r.bps >= 10_000 && r.minBinId === null);
    const bps = full ? 10_000 : Math.max(0, ...a.removeRanges.map((r) => r.bps));
    return { do: "remove", bps: mirrorRemoveBps(bps || 10_000) };
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
  if (s.memeProtection && side.sol === 0n && side.token > 0n) return skip("meme_protection");

  const sized = sizeDeposit(side.sol, s.sizing, {
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
    if (firstFunding) ratioPpm = (amount * PPM) / side.sol;
  }
  if (amount > s.dailyRoom) return skip("daily_limit");

  if (a.kind === "open") return { do: "open", amountSol: amount, ratioPpm, capped, empty: false };
  return { do: "add", amountSol: amount, ratioPpm, capped, firstFunding };
}
