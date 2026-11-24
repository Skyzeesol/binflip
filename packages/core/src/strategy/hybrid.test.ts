import { describe, expect, it } from "vitest";
import { hybridAdds, hybridBins, hybridLine, reshapeBinsFrom, shouldReshape } from "./hybrid.js";

describe("Precision Hybrid (50% spot + 50% bid-ask) and RL", () => {
  it("line sums to the total; half flat, half growing away from price", () => {
    const { base, step } = hybridLine(1_000_000n, 10);
    let sum = 0n;
    for (let i = 0n; i < 10n; i++) sum += base + step * i;
    expect(Number(sum)).toBeGreaterThan(999_000);
    expect(sum <= 1_000_000n).toBe(true);
    expect(step).toBeGreaterThan(0n);
  });

  it("SOL below/at price, token above, nearest bins smallest (bid-ask half)", () => {
    const bins = hybridBins(-20, 9, 0, { x: 1_000_000, y: 2_000_000 }, 100);
    const below = bins.filter((b) => b.id <= 0);
    const above = bins.filter((b) => b.id > 0);
    expect(below.every((b) => b.x === 0 && b.y > 0)).toBe(true);
    expect(above.every((b) => b.y === 0 && b.x > 0)).toBe(true);
    expect(below.length).toBe(21);
    expect(above.length).toBe(9);
    expect(below.find((b) => b.id === 0)!.y).toBeLessThan(below.find((b) => b.id === -20)!.y);
    expect(above.find((b) => b.id === 1)!.x).toBeLessThan(above.find((b) => b.id === 9)!.x);
    // X side is valued at the active price and divided by each (higher) bin price: never more tokens than held.
    expect(above.reduce((s, b) => s + b.x, 0)).toBeLessThanOrEqual(1_000_000);
    const sumY = below.reduce((s, b) => s + b.y, 0);
    expect(sumY).toBeGreaterThan(1_990_000);
    expect(sumY).toBeLessThanOrEqual(2_000_000);
    // Spot half: the nearest bin still holds ~1/(2n) of the side
    expect(below.find((b) => b.id === 0)!.y).toBeGreaterThan(2_000_000 / (2 * 21) - 1);
  });

  it("segments use the program's base + Δ·|d| with the base shifted to the nearest bin", () => {
    // price above the whole range: the SOL side starts 5 bins under the price
    const [a] = hybridAdds(-30, -5, 0, { x: 0n, y: 26_000_000n }, 100);
    expect(a!.minDeltaId).toBe(-30);
    expect(a!.maxDeltaId).toBe(-5);
    const nearest = a!.y0 + a!.deltaY * 5n;
    const { base } = hybridLine(26_000_000n, 26);
    expect(nearest).toBe(base);
  });

  it("RL triggers inside the range after N bins; params clamp to 1–51", () => {
    expect(shouldReshape(12, 0, -50, 50, 12)).toBe(true);
    expect(shouldReshape(11, 0, -50, 50, 12)).toBe(false);
    expect(shouldReshape(60, 0, -50, 50, 12)).toBe(false); // out of range: nothing to reshape around
    expect(reshapeBinsFrom({ reshapeBins: 99 })).toBe(51);
    expect(reshapeBinsFrom(null)).toBe(12);
  });
  it("skips ranges too wide for one transaction", () => {
    expect(shouldReshape(100, 0, -100, 200, 12)).toBe(false);
    expect(shouldReshape(100, 0, 0, 150, 12)).toBe(true);
  });
});
