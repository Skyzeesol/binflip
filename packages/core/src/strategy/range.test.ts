import { describe, expect, it } from "vitest";
import { binsForRange } from "./range.js";

describe("binsForRange (LP Agent range presets)", () => {
  it("-50% on bin step 100: whole range below price, SOL only", () => {
    const r = binsForRange(1000, 100, -50, 0);
    expect(r.upper).toBe(1000);
    expect(r.lower).toBe(1000 + Math.floor(Math.log(0.5) / Math.log(1.01)));
    expect(r.lower).toBe(930); // 1.01^-70 ≈ 0.498: the range reaches at least -50%
    expect(r.tokenShare).toBe(0);
  });

  it("±5% brackets the price and needs the token above", () => {
    const r = binsForRange(0, 100, -5, 5);
    expect(r.lower).toBe(-6);
    expect(r.upper).toBe(5);
    expect(r.bins).toBe(12);
    expect(r.tokenShare).toBeCloseTo(5 / 12);
  });

  it("small bin steps make wide ranges; too wide is refused", () => {
    expect(binsForRange(0, 20, -70, 0).bins).toBe(-Math.floor(Math.log(0.3) / Math.log(1.002)) + 1);
    expect(() => binsForRange(0, 1, -90, 0)).toThrow(/1400/);
    expect(() => binsForRange(0, 100, 5, -5)).toThrow();
  });
});
