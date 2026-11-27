import { describe, expect, it } from "vitest";
import { decide } from "./manage.js";
import { feesTakenOutLamports } from "./live.js";
import { distribute } from "./bins.js";

describe("live PnL counts fees taken out of the position", () => {
  it("claimed-and-sold fees count, compounded ones are not counted twice", () => {
    expect(feesTakenOutLamports({ claimedFeeSol: "0.02", compoundedFeeSol: "0" })).toBe(20_000_000);
    expect(feesTakenOutLamports({ claimedFeeSol: "0.05", compoundedFeeSol: "0.03" })).toBe(20_000_000);
    expect(feesTakenOutLamports({ claimedFeeSol: null, compoundedFeeSol: null })).toBe(0);
  });
  it("Telegram case: 0.5 in, 0.5459 value + 0.02 claimed → TP 10% fires (it didn't without the claimed fees)", () => {
    const bins = distribute(545_900_000, -60, -1, "bid_ask", "y", 0);
    const base = { bins, activeId: 0, binStep: 100, depositedY: 500_000_000, peakY: 545_900_000, entryActiveId: 0, lastFlipActiveId: null, lowerBinId: -60, upperBinId: -1 };
    const exits = { takeProfitBps: 1000, stopLossBps: 2500, trailingStopBps: null };
    expect(decide({ ...base, claimedFeesY: 0 }, "staged_flip", exits).do).toBe("hold");
    expect(decide({ ...base, claimedFeesY: feesTakenOutLamports({ claimedFeeSol: "0.02", compoundedFeeSol: "0" }) }, "staged_flip", exits)).toMatchObject({ do: "close", reason: "take_profit" });
  });
});
