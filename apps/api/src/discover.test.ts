import { describe, expect, it } from "vitest";
import { feeTvlChange, safetyLabel, safetyScore } from "./discover.js";

describe("safety score", () => {
  it("revoked authorities, spread supply, organic and many holders = safe", () => {
    const s = safetyScore({ mintAuthority: null, freezeAuthority: null, top10Pct: 12, organicScore: 90, holders: 5000 });
    expect(s).toBe(25 + 25 + 20 + 18 + 10);
    expect(safetyLabel(s)).toBe("safe");
  });
  it("mint authority kept and concentrated supply = risky", () => {
    const s = safetyScore({ mintAuthority: "X", freezeAuthority: "Y", top10Pct: 80, organicScore: 10, holders: 50 });
    expect(safetyLabel(s)).toBe("risky");
  });
  it("no audit data = no score", () => {
    expect(safetyScore({})).toBeNull();
  });
});

describe("fee/tvl change", () => {
  it("compares a window with the one before it", () => {
    expect(feeTvlChange({ "30m": 2, "1h": 3 }, "30m")).toBeCloseTo(100);
    expect(feeTvlChange({ "1h": 1, "2h": 3 }, "1h")).toBeCloseTo(-50);
    expect(feeTvlChange({ "4h": 4, "12h": 8 }, "4h")).toBeCloseTo(100);
  });
  it("no previous fees = no change", () => {
    expect(feeTvlChange({ "30m": 2, "1h": 2 }, "30m")).toBeNull();
  });
});
