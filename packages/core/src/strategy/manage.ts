import { binsForDrop, distribute, mergeBins, totalX, valueInY, type Bin, type Shape } from "./bins.js";
import { DEFAULT_RESHAPE_BINS, reshapeBinsFrom, shouldReshape } from "./hybrid.js";

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
  /** Staged flip trigger: price drop from entry / last flip (bps). Default 1000 = 10% (user decision), per leader. */
  thresholdBps: number;
  /** Bins used for the ask side above price. Default: as many as were withdrawn (min 10). */
  askBins: number | null;
  /** Shape of the re-added token. Default bid-ask (concentrated away from price). */
  askShape: Shape;
  /** Precision Hybrid / RL: bins the price may move before reshaping (1–51, default 12). */
  reshapeBins: number;
}

export const DEFAULT_FLIP: FlipParams = { thresholdBps: 1000, askBins: null, askShape: "bid_ask", reshapeBins: DEFAULT_RESHAPE_BINS };

/** Read flip params from copy_settings.management_params, falling back to defaults. */
export function flipParamsFrom(p: Record<string, unknown> | null | undefined): FlipParams {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const shape = p?.askShape;
  return {
    thresholdBps: n(p?.flipThresholdBps) ?? DEFAULT_FLIP.thresholdBps,
    askBins: n(p?.askBins) ?? DEFAULT_FLIP.askBins,
    askShape: shape === "spot" || shape === "curve" || shape === "bid_ask" ? shape : DEFAULT_FLIP.askShape,
    reshapeBins: reshapeBinsFrom(p),
  };
}

export interface ManagedPosition {
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
  /** Precision Hybrid: redistribute as 50% spot + 50% bid-ask around `activeId` (range unchanged). */
  | { do: "reshape"; activeId: number; movedBins: number; pnlBps: number; valueY: number }
  | { do: "close"; reason: "take_profit" | "stop_loss" | "trailing_stop"; pnlBps: number; valueY: number }
  | {
      do: "flip";
      /**
       * staged / bottom: the price fell; token-only bins move ABOVE the price (side x).
       * back: the price came back up to where the last flip started; the SOL those asks turned into
       *       goes back BELOW the price in the same bins, in the original bid-ask shape (side y).
       */
      kind: "staged" | "bottom" | "back";
      /** x = token moves (down flips), y = SOL moves (back flip). */
      side: "x" | "y";
      /** Bins to withdraw (token-only bins for x, SOL-only bins for y). */
      withdraw: { from: number; to: number };
      tokenAmount: number;
      /** SOL (lamports) a back flip moves. */
      solAmount?: number;
      /** Where it goes back in: above price for x, below price for y. */
      ask: { from: number; to: number; shape: Shape };
      dropBps: number;
      pnlBps: number;
      valueY: number;
    };

export function pnlBps(s: ManagedPosition): { pnlBps: number; valueY: number } {
  const valueY = valueInY(s.bins, s.activeId, s.binStep) + s.claimedFeesY;
  const pnl = s.depositedY > 0 ? Math.round((valueY / s.depositedY - 1) * 10_000) : 0;
  return { pnlBps: pnl, valueY };
}

/**
 * Exits first (they protect capital), then flips.
 * Trailing stop only arms once the position has been in profit, so a fresh
 * position that dips is handled by the plain stop loss ("wait for a reaction").
 */
export function decide(s: ManagedPosition, mode: ManagementMode, exits: ExitRules, flip: FlipParams = DEFAULT_FLIP): Decision {
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

  // Back flip (both flip modes): the price rose again by the same threshold from the last flip, i.e. it is back
  // where that flip started. The asks it passed are SOL again; put that SOL back below the price in the
  // original shape, so the position looks like before the flip and can flip down again.
  if ((mode === "staged_flip" || mode === "bottom_flip") && s.lastFlipActiveId !== null) {
    const needed = binsForDrop(flip.thresholdBps, s.binStep);
    if (s.activeId - s.lastFlipActiveId >= needed) {
      const solBins = s.bins.filter((b) => b.id > s.lastFlipActiveId! && b.id < s.activeId && b.y > 0 && b.x === 0);
      if (solBins.length) {
        const from = solBins[0]!.id;
        const to = solBins[solBins.length - 1]!.id;
        return {
          do: "flip",
          kind: "back",
          side: "y",
          withdraw: { from, to },
          tokenAmount: 0,
          solAmount: solBins.reduce((sum, b) => sum + b.y, 0),
          ask: { from, to, shape: "bid_ask" },
          dropBps: Math.round((Math.pow(1 + s.binStep / 10_000, s.activeId - s.lastFlipActiveId) - 1) * 10_000),
          pnlBps: pnl,
          valueY,
        };
      }
    }
  }

  if (mode === "bottom_flip" && s.activeId < s.lowerBinId) {
    // Out of range below: everything is token. Withdraw all, re-add above with 0 spread.
    const tokenBins = s.bins.filter((b) => b.x > 0);
    if (tokenBins.length && totalX(s.bins) > 0) return flipDecision("bottom", s, tokenBins, flip, s.lastFlipActiveId ?? s.entryActiveId, pnl, valueY);
  }

  if (mode === "precision_hybrid") {
    const ref = s.lastFlipActiveId ?? s.entryActiveId;
    if (shouldReshape(s.activeId, ref, s.lowerBinId, s.upperBinId, flip.reshapeBins)) {
      return { do: "reshape", activeId: s.activeId, movedBins: s.activeId - ref, pnlBps: pnl, valueY };
    }
  }

  return { do: "hold", pnlBps: pnl, valueY };
}

function flipDecision(kind: "staged" | "bottom", s: ManagedPosition, tokenBins: Bin[], flip: FlipParams, ref: number, pnl: number, valueY: number): Decision {
  const from = tokenBins[0]!.id;
  const to = tokenBins[tokenBins.length - 1]!.id;
  const n = Math.max(10, flip.askBins ?? tokenBins.length);
  return {
    do: "flip",
    kind,
    side: "x",
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
export function applyFlip(s: ManagedPosition, d: Extract<Decision, { do: "flip" }>): ManagedPosition {
  const inRange = (b: Bin) => b.id >= d.withdraw.from && b.id <= d.withdraw.to;
  const withdrawn = (b: Bin) =>
    d.kind === "bottom" ? b.x > 0 : d.kind === "back" ? inRange(b) && b.y > 0 && b.x === 0 : inRange(b) && b.x > 0 && b.y === 0;
  const remaining = s.bins.filter((b) => !withdrawn(b));
  // Back flip: SOL below the price, more of it far from the price (bid-ask, near = the active bin).
  const ask =
    d.side === "y"
      ? distribute(d.solAmount ?? 0, d.ask.from, d.ask.to, d.ask.shape, "y", s.activeId)
      : distribute(d.tokenAmount, d.ask.from, d.ask.to, d.ask.shape, "x", d.ask.from);
  const bins = mergeBins(remaining, ask);
  return {
    ...s,
    bins,
    lastFlipActiveId: s.activeId,
    lowerBinId: Math.min(...bins.map((b) => b.id)),
    upperBinId: Math.max(...bins.map((b) => b.id)),
  };
}
