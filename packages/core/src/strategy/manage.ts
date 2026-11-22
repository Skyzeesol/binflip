import { binsForDrop, distribute, mergeBins, totalX, valueInY, type Bin, type Shape } from "./bins.js";

/**
 * Position management decisions (HANDOFF §3). Pure: state in, decision out.
 * The manager service turns decisions into transactions (live) or applies
 * them to the virtual position (dry-run).
 */

export type ManagementMode = "mirror" | "staged_flip" | "bottom_flip" | "precision_hybrid";

export interface ExitRules {
  /** Close when PnL ≥ this (bps). null = off. */
  takeProfitBps: number | null;
  /** Close when PnL ≤ −this (bps). null = off. */
  stopLossBps: number | null;
  /** Close when value falls this far below its peak (bps), once the peak is above entry. null = off. */
  trailingStopBps: number | null;
}

export interface FlipParams {
  /** Staged flip trigger: price drop from entry / last flip (bps). Default 1400 = 14%. */
  thresholdBps: number;
  /** Bins used for the ask side above price. Default: as many as were withdrawn (min 10). */
  askBins: number | null;
  /** Shape of the re-added token. Default bid-ask (concentrated away from price). */
  askShape: Shape;
}

export const DEFAULT_FLIP: FlipParams = { thresholdBps: 1400, askBins: null, askShape: "bid_ask" };

export interface PositionState {
  bins: Bin[];
  activeId: number;
  binStep: number;
  /** SOL put in (lamports), net of anything taken out. */
  depositedY: number;
  /** Fees claimed so far, in SOL lamports (count toward PnL). */
  claimedFeesY: number;
  /** Highest value seen (lamports, incl. claimed fees). */
  peakY: number;
  /** Active bin at first funding, and at the last flip. */
  entryActiveId: number;
  lastFlipActiveId: number | null;
  lowerBinId: number;
  upperBinId: number;
}

export type Decision =
  | { do: "hold"; pnlBps: number; valueY: number }
  | { do: "close"; reason: "take_profit" | "stop_loss" | "trailing_stop"; pnlBps: number; valueY: number }
  | {
      do: "flip";
      kind: "staged" | "bottom";
      /** Bins to withdraw (token-only bins). */
      withdraw: { from: number; to: number };
      tokenAmount: number;
      /** Where the token goes back in, above price. */
      ask: { from: number; to: number; shape: Shape };
      dropBps: number;
      pnlBps: number;
      valueY: number;
    };

export function pnlBps(s: PositionState): { pnlBps: number; valueY: number } {
  const valueY = valueInY(s.bins, s.activeId, s.binStep) + s.claimedFeesY;
  const pnl = s.depositedY > 0 ? Math.round((valueY / s.depositedY - 1) * 10_000) : 0;
  return { pnlBps: pnl, valueY };
}

/**
 * Exits first (they protect capital), then flips.
 * Trailing stop only arms once the position has been in profit, so a fresh
 * position that dips is handled by the plain stop loss ("wait for a reaction").
 */
export function decide(s: PositionState, mode: ManagementMode, exits: ExitRules, flip: FlipParams = DEFAULT_FLIP): Decision {
  const { pnlBps: pnl, valueY } = pnlBps(s);

  if (exits.takeProfitBps !== null && pnl >= exits.takeProfitBps) return { do: "close", reason: "take_profit", pnlBps: pnl, valueY };
  if (exits.stopLossBps !== null && pnl <= -exits.stopLossBps) return { do: "close", reason: "stop_loss", pnlBps: pnl, valueY };
  if (exits.trailingStopBps !== null && s.peakY > s.depositedY) {
    const fromPeak = Math.round((valueY / s.peakY - 1) * 10_000);
    if (fromPeak <= -exits.trailingStopBps) return { do: "close", reason: "trailing_stop", pnlBps: pnl, valueY };
  }

  if (mode === "staged_flip") {
    const ref = s.lastFlipActiveId ?? s.entryActiveId;
    const needed = binsForDrop(flip.thresholdBps, s.binStep);
    if (ref - s.activeId >= needed) {
      // Token-only bins are the ones the price fell through: strictly above the active bin.
      const tokenBins = s.bins.filter((b) => b.id > s.activeId && b.x > 0 && b.y === 0);
      if (tokenBins.length) return flipDecision("staged", s, tokenBins, flip, ref, pnl, valueY);
    }
  }

  if (mode === "bottom_flip" && s.activeId < s.lowerBinId) {
    // Out of range below: everything is token. Withdraw all, re-add above with 0 spread.
    const tokenBins = s.bins.filter((b) => b.x > 0);
    if (tokenBins.length && totalX(s.bins) > 0) return flipDecision("bottom", s, tokenBins, flip, s.lastFlipActiveId ?? s.entryActiveId, pnl, valueY);
  }

  return { do: "hold", pnlBps: pnl, valueY };
}

function flipDecision(kind: "staged" | "bottom", s: PositionState, tokenBins: Bin[], flip: FlipParams, ref: number, pnl: number, valueY: number): Decision {
  const from = tokenBins[0]!.id;
  const to = tokenBins[tokenBins.length - 1]!.id;
  const n = Math.max(10, flip.askBins ?? tokenBins.length);
  return {
    do: "flip",
    kind,
    withdraw: { from, to },
    tokenAmount: tokenBins.reduce((sum, b) => sum + b.x, 0),
    // 0 spread: start right above the active bin and go up.
    ask: { from: s.activeId + 1, to: s.activeId + n, shape: flip.askShape },
    dropBps: Math.round((1 - Math.pow(1 + s.binStep / 10_000, s.activeId - ref)) * 10_000),
    pnlBps: pnl,
    valueY,
  };
}

/** Apply a flip to a virtual position (dry-run and simulations). SOL bins below are untouched. */
export function applyFlip(s: PositionState, d: Extract<Decision, { do: "flip" }>): PositionState {
  const kept = s.bins.filter((b) => !(b.id >= d.withdraw.from && b.id <= d.withdraw.to && b.x > 0 && b.y === 0) || (d.kind === "bottom" ? false : false));
  const remaining = d.kind === "bottom" ? s.bins.filter((b) => b.y > 0 && b.x === 0) : kept;
  const ask = distribute(d.tokenAmount, d.ask.from, d.ask.to, d.ask.shape, "x", d.ask.from);
  return {
    ...s,
    bins: mergeBins(remaining, ask),
    lastFlipActiveId: s.activeId,
    upperBinId: Math.max(s.upperBinId, d.ask.to),
    lowerBinId: Math.min(s.lowerBinId, ...remaining.map((b) => b.id), d.ask.from),
  };
}
