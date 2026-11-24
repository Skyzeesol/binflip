import { describe, expect, it } from "vitest";
import { applyMove, binsForDrop, distribute, moveBps, totalX, totalY, valueInY } from "./bins.js";
import { applyFlip, decide, flipParamsFrom, type ExitRules, type ManagedPosition } from "./manage.js";

const SOL = 1e9;
const NO_EXITS: ExitRules = { takeProfitBps: null, stopLossBps: null, trailingStopBps: null };

/** 1 SOL bid-ask below price over 69 bins at bin step 100 (1% per bin), like a fresh copy. */
function fresh(binStep = 100, active = 0): ManagedPosition {
  const lower = active - 68;
  return {
    bins: distribute(SOL, lower, active, "bid_ask", "y", active),
    activeId: active,
    binStep,
    depositedY: SOL,
    claimedFeesY: 0,
    peakY: SOL,
    entryActiveId: active,
    lastFlipActiveId: null,
    lowerBinId: lower,
    upperBinId: active,
  };
}

function move(s: ManagedPosition, to: number): ManagedPosition {
  return { ...s, bins: applyMove(s.bins, s.activeId, to, s.binStep), activeId: to };
}

describe("bin model", () => {
  it("bid-ask puts more SOL far from price", () => {
    const b = distribute(SOL, -68, 0, "bid_ask", "y", 0);
    expect(b[0]!.y).toBeGreaterThan(b[68]!.y * 50);
    expect(totalY(b)).toBeCloseTo(SOL, 0);
  });

  it("10% drop at bin step 100 is 11 bins (1.01^-11 ≈ -10.4%), 14% is 16", () => {
    expect(binsForDrop(1000, 100)).toBe(11);
    expect(binsForDrop(1400, 100)).toBe(16);
    expect(moveBps(0, -11, 100)).toBe(-1037);
  });

  it("price falling buys token with SOL; rising back sells it at the same bins (no fees → break-even)", () => {
    const down = move(fresh(), -20);
    expect(totalX(down.bins)).toBeGreaterThan(0);
    const up = move(down, 0);
    // Everything below the active bin is SOL again; only the active bin itself still holds token.
    expect(up.bins.filter((b) => b.x > 0).map((b) => b.id)).toEqual([0]);
    expect(valueInY(up.bins, 0, 100)).toBeCloseTo(SOL, -1);
  });
});

describe("staged flip (default 10%)", () => {
  it("defaults to 10% and reads the per-leader override", () => {
    expect(flipParamsFrom(undefined).thresholdBps).toBe(1000);
    expect(flipParamsFrom({ flipThresholdBps: 1400 }).thresholdBps).toBe(1400);
    expect(flipParamsFrom({ flipThresholdBps: "x" }).thresholdBps).toBe(1000);
  });

  it("holds before the threshold, flips at it", () => {
    expect(decide(move(fresh(), -10), "staged_flip", NO_EXITS).do).toBe("hold");
    const s = move(fresh(), -11);
    const d = decide(s, "staged_flip", NO_EXITS);
    expect(d.do).toBe("flip");
    if (d.do !== "flip") throw new Error();
    expect(d.withdraw).toEqual({ from: -10, to: 0 }); // only bins the price fell through
    expect(d.ask.from).toBe(-10); // right above the active bin, 0 spread
  });

  it("flip keeps SOL bins below untouched, moves only token, and preserves value", () => {
    const s = move(fresh(), -11);
    const d = decide(s, "staged_flip", NO_EXITS);
    if (d.do !== "flip") throw new Error();
    const after = applyFlip(s, d);
    const solBelow = (p: ManagedPosition) => p.bins.filter((b) => b.id <= -11).map((b) => b.y);
    expect(solBelow(after)).toEqual(solBelow(s));
    expect(totalX(after.bins)).toBeCloseTo(totalX(s.bins), 6);
    expect(after.bins.filter((b) => b.x > 0).every((b) => b.id > after.activeId)).toBe(true);
    expect(valueInY(after.bins, -11, 100)).toBeCloseTo(valueInY(s.bins, -11, 100), -2);
    expect(after.lastFlipActiveId).toBe(-11);
  });

  it("next flip is measured from the last flip, not from entry", () => {
    let s = move(fresh(), -11);
    const d1 = decide(s, "staged_flip", NO_EXITS);
    if (d1.do !== "flip") throw new Error();
    s = applyFlip(s, d1);
    expect(decide(move(s, -15), "staged_flip", NO_EXITS).do).toBe("hold");
    expect(decide(move(s, -22), "staged_flip", NO_EXITS).do).toBe("flip");
  });

  it("a rebound after the flip sells the token above the bottom", () => {
    let s = move(fresh(), -11);
    const d = decide(s, "staged_flip", NO_EXITS);
    if (d.do !== "flip") throw new Error();
    s = applyFlip(s, d);
    const rebounded = move(s, 5);
    expect(totalX(rebounded.bins)).toBe(0); // all token sold back into SOL
  });

  it("mirror mode never flips", () => {
    expect(decide(move(fresh(), -30), "mirror", NO_EXITS).do).toBe("hold");
  });
});

describe("bottom flip", () => {
  it("waits until out of range below, then moves everything above price", () => {
    expect(decide(move(fresh(), -60), "bottom_flip", NO_EXITS).do).toBe("hold");
    const s = move(fresh(), -70);
    const d = decide(s, "bottom_flip", NO_EXITS);
    expect(d).toMatchObject({ do: "flip", kind: "bottom" });
    if (d.do !== "flip") throw new Error();
    const after = applyFlip(s, d);
    expect(totalY(after.bins)).toBe(0);
    expect(Math.min(...after.bins.map((b) => b.id))).toBe(-69);
  });
});

describe("exits", () => {
  const withPnl = (pnlBps: number, peakBps = 0): ManagedPosition => {
    const s = fresh();
    const value = SOL * (1 + pnlBps / 10_000);
    return { ...s, depositedY: SOL, bins: [{ id: -1, x: 0, y: value }], peakY: SOL * (1 + peakBps / 10_000) };
  };
  const rules: ExitRules = { takeProfitBps: 1000, stopLossBps: 1000, trailingStopBps: 500 };

  it("take profit and stop loss", () => {
    expect(decide(withPnl(1000), "mirror", rules)).toMatchObject({ do: "close", reason: "take_profit" });
    expect(decide(withPnl(-1000), "mirror", rules)).toMatchObject({ do: "close", reason: "stop_loss" });
    expect(decide(withPnl(-900), "mirror", rules).do).toBe("hold");
  });

  it("trailing stop arms only after being in profit", () => {
    // Never in profit: a 6% dip is left to the plain stop loss.
    expect(decide(withPnl(-600, 0), "mirror", rules).do).toBe("hold");
    // Was +8%, now +2%: fell >5% from the peak → exit with profit.
    expect(decide(withPnl(200, 800), "mirror", rules)).toMatchObject({ do: "close", reason: "trailing_stop" });
  });

  it("claimed fees count toward PnL", () => {
    const s = { ...withPnl(500), claimedFeesY: 0.06 * SOL };
    expect(decide(s, "mirror", rules)).toMatchObject({ do: "close", reason: "take_profit" });
  });
});

import { hybridBins } from "./hybrid.js";

describe("precision hybrid decisions", () => {
  const base = { binStep: 100, depositedY: 1e9, claimedFeesY: 0, peakY: 1e9, lowerBinId: -60, upperBinId: 10, lastFlipActiveId: null };
  it("reshapes after the configured bins inside the range, holds before", () => {
    const bins = hybridBins(-60, 10, 0, { x: 0, y: 1e9 }, 100);
    const moved = decide({ ...base, bins, activeId: -12, entryActiveId: 0 }, "precision_hybrid", { takeProfitBps: null, stopLossBps: null, trailingStopBps: null });
    expect(moved).toMatchObject({ do: "reshape", activeId: -12, movedBins: -12 });
    const little = decide({ ...base, bins, activeId: -11, entryActiveId: 0 }, "precision_hybrid", { takeProfitBps: null, stopLossBps: null, trailingStopBps: null });
    expect(little.do).toBe("hold");
  });
  it("exits still win over reshaping", () => {
    const bins = hybridBins(-60, 10, 0, { x: 0, y: 5e8 }, 100);
    const d = decide({ ...base, bins, activeId: -20, entryActiveId: 0 }, "precision_hybrid", { takeProfitBps: null, stopLossBps: 1000, trailingStopBps: null });
    expect(d.do).toBe("close");
  });
});
