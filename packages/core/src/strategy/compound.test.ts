import { describe, expect, it } from "vitest";
import { compoundRanges, shouldCompound, type CompoundCheck } from "./compound.js";

const SOL = 1_000_000_000n;
const now = new Date("2026-11-22T12:00:00Z");
const base: CompoundCheck = {
  feeX: 0n,
  feeY: SOL / 20n, // 0.05 SOL
  activeId: 0,
  binStep: 100,
  lastCompoundAt: new Date(now.getTime() - 61 * 60_000),
  openedAt: null,
  intervalMinutes: 60,
  minLamports: SOL / 50n, // 0.02 SOL
  now,
};

describe("shouldCompound", () => {
  it("compounds when the interval passed and fees are worth it", () => {
    expect(shouldCompound(base)).toMatchObject({ do: "compound", feesValueY: SOL / 20n });
  });
  it("is off without an interval", () => {
    expect(shouldCompound({ ...base, intervalMinutes: null })).toMatchObject({ do: "wait", reason: "off" });
  });
  it("waits for the interval", () => {
    expect(shouldCompound({ ...base, lastCompoundAt: new Date(now.getTime() - 30 * 60_000) })).toMatchObject({ reason: "interval" });
  });
  it("skips dust: fees below the minimum are left to grow", () => {
    expect(shouldCompound({ ...base, feeY: SOL / 100n })).toMatchObject({ do: "wait", reason: "below_min" });
  });
  it("values token fees at the active bin price", () => {
    // 0.01 SOL + 0.02 SOL worth of token at price 1 (bin 0) = 0.03 SOL ≥ 0.02
    expect(shouldCompound({ ...base, feeY: SOL / 100n, feeX: SOL / 50n })).toMatchObject({ do: "compound", feesValueY: 30_000_000n });
  });
  it("first compound is measured from the open", () => {
    expect(shouldCompound({ ...base, lastCompoundAt: null, openedAt: new Date(now.getTime() - 10 * 60_000) })).toMatchObject({ reason: "interval" });
  });
});

describe("compoundRanges", () => {
  it("SOL below/at price, token above, inside the range", () => {
    expect(compoundRanges(-68, 10, 0)).toEqual({ sol: { from: -68, to: 0 }, token: { from: 1, to: 10 } });
  });
  it("single-sided bid position (range ends at price): token fees have no bins → sold", () => {
    expect(compoundRanges(-68, 0, 0)).toEqual({ sol: { from: -68, to: 0 }, token: null });
  });
  it("out of range below: no SOL bins", () => {
    expect(compoundRanges(-68, 0, -80).sol).toBeNull();
  });
});
