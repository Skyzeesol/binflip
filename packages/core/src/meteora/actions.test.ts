import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WSOL_MINT } from "../constants.js";
import { decodeMeteoraTx } from "./decode.js";
import { extractActions, type LeaderAction } from "./actions.js";
import type { RawTransaction } from "./rawTx.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../test/fixtures/tx");
const KARINCA = "zbmg9d5xHtouvKtFGqASdKbHEQ4bQdJwqtQPkdvc3Ud";

function load(prefix: string): RawTransaction {
  const f = fs.readdirSync(dir).find((n) => n.startsWith(prefix));
  if (!f) throw new Error(`fixture ${prefix} missing`);
  return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
}

function only(prefix: string): LeaderAction {
  const acts = extractActions(decodeMeteoraTx(load(prefix)));
  expect(acts).toHaveLength(1);
  return acts[0]!;
}

// Real mainnet transactions from the "Disiplinli Karınca" wallet (2026-11-22).
describe("extractActions on Karınca fixtures", () => {
  it("open: initialize_position2 + increase_position_length2 → empty open with range", () => {
    const a = only("dlmm-2VwaJF3R6N");
    expect(a.kind).toBe("open");
    expect(a.owner).toBe(KARINCA);
    expect([a.lowerBinId, a.upperBinId]).toEqual([-599, -512]);
    expect(a.added).toEqual({ x: 0n, y: 0n });
  });

  it("funding add via rebalance_liquidity → bid-ask, SOL side only", () => {
    const a = only("dlmm-2JLH3PoCgr");
    expect(a.kind).toBe("add");
    expect(a.strategy).toBe("bid_ask");
    expect(a.added).toEqual({ x: 0n, y: 218_335_023n });
    expect(a.mintY).toBe(WSOL_MINT);
  });

  it("rebalance_liquidity carries the full move detail (old/new range, add segments)", () => {
    const a = only("dlmm-2JLH3PoCgr");
    expect(a.rebalance).toMatchObject({ oldMin: -599, oldMax: -512, newMin: -599, newMax: -512, favorX: false });
    expect(a.rebalance?.adds).toHaveLength(1);
    expect(a.rebalance?.adds[0]).toMatchObject({ min_delta_id: -17, max_delta_id: 0 });
  });

  it("close: remove_by_range2 + claim_fee2 + close_position_if_empty", () => {
    const a = only("dlmm-2oxGTs22bM");
    expect(a.kind).toBe("close");
    expect(a.closed).toBe(true);
    expect(a.removed.y).toBe(22_493_334_999n);
    expect(a.fees.y).toBe(19_034_780n);
    expect(a.removeRanges[0]?.bps).toBe(10_000);
  });

  it("close_position_if_empty that did not close stays a remove", () => {
    const a = only("dlmm-5Az7uJaC7s");
    expect(a.kind).toBe("remove");
    expect(a.closed).toBe(false);
  });

  it("claim only", () => {
    const a = only("dlmm-qmstRM3XyA");
    expect(a.kind).toBe("claim");
    expect(a.fees.y).toBe(285_128_098n);
  });

  it("swaps routed through DLMM produce no action", () => {
    expect(extractActions(decodeMeteoraTx(load("dlmm-58bc77bzE6")))).toEqual([]);
  });

  it("non-Meteora transactions produce no action", () => {
    for (const f of fs.readdirSync(dir).filter((n) => n.startsWith("other-"))) {
      const tx = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      expect(extractActions(decodeMeteoraTx(tx))).toEqual([]);
    }
  });
});

describe("DLMM per-bin remove_liquidity", () => {
  it("keeps the bins: consecutive bins with the same bps become one range", () => {
    const ix = (name: string, args: Record<string, unknown>) => ({
      kind: "ix" as const,
      protocol: "dlmm" as const,
      name,
      accounts: { position: "Pos1111111111111111111111111111111111111111", lb_pair: "Pool111111111111111111111111111111111111111", sender: "Lead111111111111111111111111111111111111111" },
      args,
      topIndex: 0,
      innerIndex: null,
    });
    const removal = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19].map((id) => ({ bin_id: id, bps_to_remove: 10_000 })).concat([{ bin_id: 30, bps_to_remove: 5_000 }]);
    const [a] = extractActions([ix("remove_liquidity2", { bin_liquidity_removal: removal })] as never);
    expect(a?.kind).toBe("remove");
    expect(a?.removeRanges).toEqual([
      { minBinId: 10, maxBinId: 19, bps: 10_000 },
      { minBinId: 30, maxBinId: 30, bps: 5_000 },
    ]);
  });
});
