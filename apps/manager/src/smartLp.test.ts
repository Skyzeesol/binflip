import { describe, expect, it } from "vitest";
import { scoreWallet } from "./smartLp.js";

const now = Date.parse("2026-11-23T12:00:00Z");
const day = (d: number) => (now - d * 86_400_000) / 1000;

describe("scoreWallet (Smart LP)", () => {
  const closed = [
    { pools: [
      { pnlSol: "2", totalFeeSol: "1", totalDepositSol: "10", lastClosedAt: day(1) },
      { pnlSol: "-1", totalFeeSol: "0.2", totalDepositSol: "20", lastClosedAt: day(10) },
      { pnlSol: "3", totalFeeSol: "0.5", totalDepositSol: "30", lastClosedAt: day(60) },
    ] },
  ];
  const open = { total: { balancesSol: "5" }, pools: [{ poolAddress: "P1", tokenXMint: "T1", tokenYMint: "So11111111111111111111111111111111111111112", updatedAt: day(0.1) }] };

  it("pool-level win rate, windows, EV, fees and activity", () => {
    const s = scoreWallet("W", { totalPnlSol: "100", totalClosedPositions: 500 }, closed, open, now);
    expect(s.totalPnlSol).toBe(100);
    expect(s.closedPositions).toBe(500);
    expect(s.winRate).toBeCloseTo(66.667, 2);
    expect(s.pnl7dSol).toBe(2);
    expect(s.pnl30dSol).toBe(1);
    expect(s.feesSol).toBeCloseTo(1.7);
    expect(s.evSol).toBeCloseTo((2 / 3) * 2.5 + (1 / 3) * -1);
    expect(s.avgInvestedSol).toBe(20);
    expect(s.openValueSol).toBe(5);
    expect(s.openTokens).toEqual(["T1"]);
    expect(s.daily).toEqual([{ day: "2026-11-22", pnl: 2 }]);
    expect(s.feeChecked).toBe(true); // 1.7 SOL fees vs 4 SOL sampled profit
  });

  it("not fee-checked when profit comes from price, not fees (< 10%)", () => {
    const s = scoreWallet("W", {}, [{ pools: [{ pnlSol: "50", totalFeeSol: "1", totalDepositSol: "10", lastClosedAt: day(1) }] }], { pools: [] }, now);
    expect(s.feeChecked).toBe(false);
  });
});
