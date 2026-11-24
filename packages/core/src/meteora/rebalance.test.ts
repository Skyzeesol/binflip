import { describe, expect, it } from "vitest";
import type { LeaderAction } from "./actions.js";
import { classifyRebalance } from "./rebalance.js";

const SOL = 1_000_000_000n;
const add = { min_delta_id: -10, max_delta_id: 0, x0: 0n, y0: 100n, delta_x: 0n, delta_y: 10n, bit_flag: 0 };

const rb = (o: Partial<LeaderAction>): LeaderAction => ({
  protocol: "dlmm",
  kind: "rebalance",
  position: "P",
  pool: "Pool",
  owner: "L",
  ixIndex: 0,
  instructions: ["rebalance_liquidity"],
  created: false,
  closed: false,
  mintX: "T",
  mintY: "So11111111111111111111111111111111111111112",
  added: { x: 0n, y: SOL },
  removed: { x: 0n, y: SOL },
  fees: { x: 0n, y: 0n },
  strategy: "bid_ask",
  lowerBinId: -120,
  upperBinId: -50,
  activeBinId: -50,
  removeRanges: [{ minBinId: -100, maxBinId: -30, bps: 10_000 }],
  rebalance: { oldMin: -100, oldMax: -30, newMin: -120, newMax: -50, adds: [add], favorX: false },
  ...o,
});

describe("classifyRebalance (LP Agent rules)", () => {
  it("full move with the same amounts is mirrored", () => {
    expect(classifyRebalance(rb({}))).toEqual({ ok: true });
    // within ±3% (fees, rounding)
    expect(classifyRebalance(rb({ added: { x: 0n, y: (SOL * 98n) / 100n } }))).toEqual({ ok: true });
  });

  it("moving only part of the position is skipped", () => {
    expect(classifyRebalance(rb({ removeRanges: [{ minBinId: -100, maxBinId: -30, bps: 5_000 }] }))).toMatchObject({ reason: "rebalance_partial" });
    expect(classifyRebalance(rb({ removeRanges: [{ minBinId: -80, maxBinId: -30, bps: 10_000 }] }))).toMatchObject({ reason: "rebalance_partial" });
  });

  it("topping up in the same move is skipped", () => {
    expect(classifyRebalance(rb({ added: { x: 0n, y: (SOL * 120n) / 100n } }))).toMatchObject({ reason: "rebalance_topup" });
  });

  it("taking profit in the same move is skipped", () => {
    expect(classifyRebalance(rb({ added: { x: 0n, y: SOL / 2n } }))).toMatchObject({ reason: "rebalance_take_profit" });
  });

  it("whole-position removal (no bin bounds) counts as full", () => {
    expect(classifyRebalance(rb({ removeRanges: [{ minBinId: null, maxBinId: null, bps: 10_000 }] }))).toEqual({ ok: true });
  });
});

import { scaleAdds, signedAdds } from "./rebalance.js";

describe("single-transaction rebalance scaling", () => {
  it("applies bit_flag signs (1 x0, 2 y0, 4 Δx, 8 Δy)", () => {
    const [a] = signedAdds([{ min_delta_id: -10, max_delta_id: -1, x0: 5n, y0: 7n, delta_x: 2n, delta_y: 3n, bit_flag: 1 | 8 }]);
    expect(a).toEqual({ minDeltaId: -10, maxDeltaId: -1, x0: -5n, y0: 7n, deltaX: 2n, deltaY: -3n });
  });

  it("scales each side by our withdrawn / leader withdrawn, with a haircut", () => {
    const adds = [{ minDeltaId: -5, maxDeltaId: 0, x0: 0n, y0: 1_000_000n, deltaX: 0n, deltaY: 200_000n }];
    // We hold 1% of the leader's SOL side; no token side.
    const [a] = scaleAdds(adds, { x: 0n, y: 10_000_000n }, { x: 0n, y: 1_000_000_000n }, 50);
    expect(a!.y0).toBe((1_000_000n * 10_000_000n * 9950n) / (1_000_000_000n * 10_000n));
    expect(a!.deltaY).toBe((200_000n * 10_000_000n * 9950n) / (1_000_000_000n * 10_000n));
    expect(a!.x0).toBe(0n);
    expect(a!.minDeltaId).toBe(-5);
  });

  it("a side the leader did not withdraw is not deposited", () => {
    const [a] = scaleAdds([{ minDeltaId: 1, maxDeltaId: 9, x0: 100n, y0: 0n, deltaX: 10n, deltaY: 0n }], { x: 50n, y: 0n }, { x: 0n, y: 0n });
    expect(a!.x0).toBe(0n);
    expect(a!.deltaX).toBe(0n);
  });
});
