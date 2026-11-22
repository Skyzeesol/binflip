import { describe, expect, it } from "vitest";
import { classifyRebalanceAdds, strategyFromType } from "./strategy.js";

const add = (o: Partial<Parameters<typeof classifyRebalanceAdds>[0][number]>) => ({
  min_delta_id: -10,
  max_delta_id: 0,
  x0: 0n,
  y0: 0n,
  delta_x: 0n,
  delta_y: 0n,
  bit_flag: 0,
  ...o,
});

describe("strategy classification", () => {
  it("maps StrategyType enum variants", () => {
    expect(strategyFromType({ SpotOneSide: {} })).toBe("spot");
    expect(strategyFromType({ CurveBalanced: {} })).toBe("curve");
    expect(strategyFromType({ BidAskImBalanced: {} })).toBe("bid_ask");
  });

  it("spot: zero delta", () => {
    expect(classifyRebalanceAdds([add({ y0: 100n })])).toBe("spot");
  });

  it("bid-ask: positive delta", () => {
    expect(classifyRebalanceAdds([add({ y0: 5n, delta_y: 5n })])).toBe("bid_ask");
  });

  it("curve: negated delta (bit 8 for y)", () => {
    expect(classifyRebalanceAdds([add({ y0: 50n, delta_y: 5n, bit_flag: 8 })])).toBe("curve");
  });

  it("mixed segments are custom", () => {
    expect(classifyRebalanceAdds([add({ y0: 100n }), add({ x0: 5n, delta_x: 5n })])).toBe("custom");
  });
});
