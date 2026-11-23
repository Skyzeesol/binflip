import { describe, expect, it } from "vitest";
import { safetyLabel, safetyScore } from "./discover.js";

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
