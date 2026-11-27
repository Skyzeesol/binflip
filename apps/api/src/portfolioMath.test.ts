import { describe, expect, it } from "vitest";
import { bucketOf, history, positionMetrics, rangeVsPrice, summarize, accountTotals } from "./portfolioMath.js";

describe("portfolio math (LP Agent definitions)", () => {
  const now = new Date("2026-11-23T12:00:00Z");

  it("PnL adds claimed fees that left the position, not compounded ones", () => {
    const m = positionMetrics({ invested: 10, value: 10.5, claimedFee: 0.4, compoundedFee: 0.1, unclaimedFee: 0.2, openedAt: new Date("2026-11-21T12:00:00Z"), closedAt: null }, now);
    expect(m.totalFee).toBeCloseTo(0.6);
    expect(m.feePct).toBeCloseTo(6);
    expect(m.pnl).toBeCloseTo(0.8); // 10.5 + (0.4 - 0.1) - 10
    expect(m.pnlPct).toBeCloseTo(8);
    expect(m.dpr).toBeCloseTo(3); // 6% over 2 days
  });

  it("no value or no cost basis = no PnL", () => {
    expect(positionMetrics({ invested: 0, value: 1, claimedFee: 0, compoundedFee: 0, unclaimedFee: 0, openedAt: null, closedAt: null }).pnl).toBeNull();
    expect(positionMetrics({ invested: 1, value: null, claimedFee: 0, compoundedFee: 0, unclaimedFee: 0, openedAt: null, closedAt: null }).pnl).toBeNull();
  });

  it("summary: win rate, EV with a negative average loss, monthly profit", () => {
    const first = new Date("2026-09-24T12:00:00Z"); // 60 days before now = 2 months
    const s = summarize(
      [
        { invested: 2, pnl: 1, firstAt: first },
        { invested: 2, pnl: 3, firstAt: first },
        { invested: 4, pnl: -2, firstAt: first },
        { invested: 4, pnl: null, firstAt: first },
      ],
      1.5,
      now,
    );
    expect(s.totalClosed).toBe(4);
    expect(s.winRate).toBeCloseTo(66.667, 2);
    expect(s.avgInvested).toBe(3);
    expect(s.totalProfit).toBe(2);
    expect(s.avgMonthlyProfit).toBeCloseTo(1);
    expect(s.expectedValue).toBeCloseTo((2 / 3) * 2 + (1 / 3) * -2);
    expect(s.feeEarned).toBe(1.5);
  });

  it("buckets: day, ISO week from Monday, month", () => {
    const d = new Date("2026-11-26T23:00:00Z"); // Thursday
    expect(bucketOf(d, "day")).toBe("2026-11-26");
    expect(bucketOf(d, "week")).toBe("2026-11-23");
    expect(bucketOf(new Date("2026-11-22T10:00:00Z"), "week")).toBe("2026-11-16"); // Sunday → previous Monday
    expect(bucketOf(d, "month")).toBe("2026-11-01");
    expect(history([{ at: d, value: 1 }, { at: new Date("2026-11-24T00:00:00Z"), value: 2 }, { at: new Date("2026-11-01T00:00:00Z"), value: -1 }], "week")).toEqual([
      { bucket: "2026-10-26", value: -1, count: 1, missing: 0 },
      { bucket: "2026-11-23", value: 3, count: 2, missing: 0 },
    ]);
  });

  it("unknown PnL is not zero: counted as missing, never summed", () => {
    const day = new Date("2026-11-26T10:00:00Z");
    // one closed at 0 SOL profit, one closed without a known value
    expect(history([{ at: day, value: 0 }, { at: day, value: null }], "day")).toEqual([{ bucket: "2026-11-26", value: 0, count: 2, missing: 1 }]);
    // only the unknown one: no number at all
    expect(history([{ at: day, value: null }], "day")).toEqual([{ bucket: "2026-11-26", value: null, count: 1, missing: 1 }]);
  });

  it("range vs price", () => {
    const r = rangeVsPrice(-68, 0, 0, 100)!;
    expect(r.inRange).toBe(true);
    expect(r.bins).toBe(69);
    expect(r.lowerPct).toBeCloseTo((Math.pow(1.01, -68) - 1) * 100);
    expect(r.upperPct).toBeCloseTo(1);
    expect(rangeVsPrice(-68, -10, 0, 100)!.inRange).toBe(false);
    expect(rangeVsPrice(null, 0, 0, 100)).toBeNull();
  });
});

describe("account totals", () => {
  it("dry-run positions never count towards the live net worth", () => {
    const t = accountTotals({ sol: 2, tokensValue: 0, positions: [{ value: 3, dryRun: true }] });
    expect(t).toMatchObject({ netWorth: 2, positionsValue: 0, dryRunValue: 3, complete: true });
    const t2 = accountTotals({ sol: 2, tokensValue: 0, positions: [{ value: 3, dryRun: true }, { value: 1, dryRun: false }] });
    expect(t2.netWorth).toBe(3);
  });
  it("no wallet balance = no net worth (never positions alone)", () => {
    expect(accountTotals({ sol: null, tokensValue: 0, positions: [{ value: 1, dryRun: false }] })).toMatchObject({ netWorth: null, complete: false, positionsValue: 1 });
  });
});
