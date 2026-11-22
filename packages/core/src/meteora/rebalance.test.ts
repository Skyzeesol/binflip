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
