import { describe, expect, it } from "vitest";
import { evaluateFundProtection } from "./fundProtection.js";

const SOL = 1_000_000_000n;

describe("fund protection (LP Agent)", () => {
  it("fixes the limit from net worth on first evaluation (20% of 10 SOL = 2 SOL)", () => {
    const s = evaluateFundProtection({ realizedLamports: 0n, peakLamports: 0n, limitLamports: null, lossBps: 2000, netWorthLamports: 10n * SOL });
    expect(s).toMatchObject({ limitLamports: 2n * SOL, tripped: false });
  });

  it("measures losses from the peak, not from zero", () => {
    // +3 SOL realized, then down to +0.5 → 2.5 SOL from peak ≥ 2 SOL limit
    const up = evaluateFundProtection({ realizedLamports: 3n * SOL, peakLamports: 0n, limitLamports: 2n * SOL, lossBps: 2000, netWorthLamports: 0n });
    expect(up).toMatchObject({ peakLamports: 3n * SOL, tripped: false });
    const down = evaluateFundProtection({ realizedLamports: SOL / 2n, peakLamports: up.peakLamports, limitLamports: 2n * SOL, lossBps: 2000, netWorthLamports: 0n });
    expect(down).toMatchObject({ drawdownLamports: (5n * SOL) / 2n, tripped: true });
  });

  it("a small dip below the peak does not trip", () => {
    expect(evaluateFundProtection({ realizedLamports: -SOL, peakLamports: 0n, limitLamports: 2n * SOL, lossBps: 2000, netWorthLamports: 0n }).tripped).toBe(false);
  });
});
