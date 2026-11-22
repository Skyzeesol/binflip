import { describe, expect, it } from "vitest";
import { SWAPBACK_MAX_ATTEMPTS, swapBackDelayMs } from "./queues.js";

describe("swap-back retry schedule", () => {
  it("backs off 30s, 1m, 2m, 4m … and caps at 15 minutes", () => {
    expect([1, 2, 3, 4, 5, 6, 10].map(swapBackDelayMs)).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000]);
  });
  it("keeps trying for days, not minutes", () => {
    const total = Array.from({ length: SWAPBACK_MAX_ATTEMPTS }, (_, i) => swapBackDelayMs(i + 1)).reduce((a, b) => a + b, 0);
    expect(total / 86_400_000).toBeGreaterThan(7);
  });
});
