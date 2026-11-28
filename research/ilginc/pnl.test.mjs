// node --test research/ilginc/pnl.test.mjs  — regression: a missing price must never value tokens at 0.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const here = path.dirname(new URL(import.meta.url).pathname);
function run(closeActive) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pnl-"));
  fs.writeFileSync(path.join(dir, "pools.json"), JSON.stringify({ L: { binStep: 100, name: "T-SOL", y: "So11111111111111111111111111111111111111112" } }));
  const rows = [
    // open with 1 SOL at active 0
    { slot: 1, t: 0, pool: "L", position: "P", kind: "initialize_position+add_liquidity_by_strategy2", created: true, active: 0, addX: "0", addY: "1000000000" },
    // price fell through the bin: the position is now tokens worth 1.1 SOL at bin 0 (price 1)
    { slot: 2, t: 60, pool: "L", position: "P", kind: "rebalance_liquidity", newMin: 1, active: 0, xW: "1100000000", yW: "0", xA: "1100000000", yA: "0", xF: "0", yF: "0" },
    // close: all tokens withdrawn; active present or missing
    { slot: 3, t: 120, pool: "L", position: "P", kind: "remove_liquidity_by_range2+claim_fee2+close_position_if_empty", closed: true, active: closeActive, remX: "1100000000", remY: "0", feeX: "0", feeY: "0" },
  ];
  fs.writeFileSync(path.join(dir, "rows.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const out = execFileSync("node", [path.join(here, "pnl.mjs")], { env: { ...process.env, DATA_DIR: dir }, encoding: "utf8" });
  const priced = fs.readFileSync(path.join(dir, "pnl.jsonl"), "utf8").trim();
  const unpriced = fs.readFileSync(path.join(dir, "pnl-unpriced.jsonl"), "utf8").trim();
  return { out, priced: priced ? priced.split("\n").map((l) => JSON.parse(l)) : [], unpriced: unpriced ? unpriced.split("\n").map((l) => JSON.parse(l)) : [] };
}

test("with a price at close the position is valued (+10%)", () => {
  const r = run(0);
  assert.equal(r.unpriced.length, 0);
  assert.equal(r.priced.length, 1);
  assert.equal(r.priced[0].pnlPct, 10);
});

test("without a price at close the position is flagged, not counted as −100%", () => {
  const r = run(null);
  assert.equal(r.priced.length, 0, "must not enter the totals");
  assert.equal(r.unpriced.length, 1);
  assert.equal(r.unpriced[0].tokenAtClose, true);
  assert.match(r.out, /fiyatsız \(değerlendirilemeyen\) pozisyon: 1 \/ 1/);
});

function runRows(rows, pools = { L: { binStep: 100, name: "T-SOL", y: "So11111111111111111111111111111111111111112" } }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pnl-"));
  fs.writeFileSync(path.join(dir, "pools.json"), JSON.stringify(pools));
  fs.writeFileSync(path.join(dir, "rows.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const out = execFileSync("node", [path.join(here, "pnl.mjs")], { env: { ...process.env, DATA_DIR: dir }, encoding: "utf8" });
  const priced = fs.readFileSync(path.join(dir, "pnl.jsonl"), "utf8").trim();
  return { out, priced: priced ? priced.split("\n").map((l) => JSON.parse(l)) : [] };
}

test("1 SOL open + 1 SOL add + 0.2 SOL claimed fee → +0.2 SOL gross on 2 SOL capital (+10%), fee 0.2", () => {
  const r = runRows([
    { slot: 1, t: 0, pool: "L", position: "P", kind: "initialize_position2+add_liquidity_by_strategy2", created: true, active: 0, addX: "0", addY: "1000000000" },
    { slot: 2, t: 60, pool: "L", position: "P", kind: "add_liquidity_by_strategy2", active: 0, addX: "0", addY: "1000000000" },
    { slot: 3, t: 120, pool: "L", position: "P", kind: "claim_fee2", active: 0, feeX: "0", feeY: "200000000" },
    { slot: 4, t: 180, pool: "L", position: "P", kind: "remove_liquidity_by_range2+close_position_if_empty", closed: true, active: 0, remX: "0", remY: "2000000000", feeX: "0", feeY: "0" },
  ]);
  assert.equal(r.priced.length, 1);
  assert.equal(r.priced[0].pnlSol, 0.2);
  assert.equal(r.priced[0].lotSol, 2);
  assert.equal(r.priced[0].pnlPct, 10);
  assert.equal(r.priced[0].feeSol, 0.2);
  assert.equal(r.priced[0].adds, 1);
  assert.equal(r.priced[0].claims, 1);
});

test("a partial remove reduces the capital at risk but not the capital measured against", () => {
  const r = runRows([
    { slot: 1, t: 0, pool: "L", position: "P", kind: "initialize_position2+add_liquidity_by_strategy2", created: true, active: 0, addX: "0", addY: "2000000000" },
    { slot: 2, t: 60, pool: "L", position: "P", kind: "remove_liquidity_by_range2", active: 0, remX: "0", remY: "1000000000" },
    { slot: 3, t: 120, pool: "L", position: "P", kind: "remove_liquidity_by_range2+close_position_if_empty", closed: true, active: 0, remX: "0", remY: "1100000000", feeX: "0", feeY: "0" },
  ]);
  assert.equal(r.priced[0].pnlSol, 0.1);
  assert.equal(r.priced[0].lotSol, 2);
});

test("a pool where SOL is not Y is left out and counted apart", () => {
  const r = runRows([
    { slot: 1, t: 0, pool: "Q", position: "P", kind: "initialize_position2", created: true, active: 0, addX: "1000000000", addY: "0" },
    { slot: 2, t: 60, pool: "Q", position: "P", kind: "close_position_if_empty", closed: true, active: 0, remX: "1000000000", remY: "0" },
  ], { Q: { binStep: 100, name: "SOL-USDC", x: "So11111111111111111111111111111111111111112", y: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" } });
  assert.equal(r.priced.length, 0);
  assert.match(r.out, /SOL'ün Y olmadığı havuzlardaki pozisyon \(dışarıda\): 1/);
});

