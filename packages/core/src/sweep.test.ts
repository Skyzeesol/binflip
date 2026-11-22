import { describe, expect, it } from "vitest";
import { SWEEP_FEE_BUFFER, sweepAmount } from "./sweep.js";

const SOL = 1_000_000_000n;

describe("sweepAmount", () => {
  it("sends everything above the working capital", () => {
    expect(sweepAmount(8n * SOL, 5n * SOL, SOL / 2n)).toBe(3n * SOL - SWEEP_FEE_BUFFER);
  });
  it("waits until the excess is worth a transfer", () => {
    expect(sweepAmount(5n * SOL + SOL / 10n, 5n * SOL, SOL / 2n)).toBeNull();
  });
  it("never dips into the working capital", () => {
    expect(sweepAmount(4n * SOL, 5n * SOL, 0n)).toBeNull();
  });
});
