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
