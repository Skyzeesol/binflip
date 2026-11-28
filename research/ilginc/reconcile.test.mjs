// node --test research/ilginc/reconcile.test.mjs — attribution regressions (synthetic rows).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const here = path.dirname(new URL(import.meta.url).pathname);
const WSOL = "So11111111111111111111111111111111111111112";
function run(rows, est) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rec-"));
  fs.writeFileSync(path.join(dir, "pools.json"), JSON.stringify({ L: { binStep: 100, x: "M", y: WSOL }, L2: { binStep: 100, x: "M", y: WSOL } }));
  fs.writeFileSync(path.join(dir, "rows.jsonl"), rows.map((r) => JSON.stringify({ walletRow: true, positionsInTx: r.position ? 1 : 0, ...r })).join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "pnl.jsonl"), est.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return execFileSync("node", [path.join(here, "reconcile.mjs")], { env: { ...process.env, DATA_DIR: dir }, encoding: "utf8" });
}
const e = (position) => ({ position, name: "T-SOL", lotSol: 1, pnlPct: 0, pnlSol: 0, feePct: 0, feeSol: 0, rebalances: 0 });
const posLine = (out) => out.split("\n").find((l) => l.startsWith("karşılaştırılabilir:"));
const realLine = (out) => out.split("\n").find((l) => l.startsWith("Σ gerçekleşen"));

test("a rebalance+swap signature of the position is counted once (not also as a sale)", () => {
  const rows = [
    { sig: "o", slot: 1, t: 0, kind: "initialize_position2+add_liquidity2", position: "P", pool: "L", created: true, solDelta: -1_000_000_000, tokDelta: {} },
    // the position's own tx also swaps (kind contains swap): its wallet change belongs to the position
    // withdraws 700 tokens and swaps 500 of them in the same tx: +200 tokens, +0.1 SOL
    { sig: "rs", slot: 2, t: 60, kind: "rebalance_liquidity+swap", position: "P", pool: "L", solDelta: 100_000_000, tokDelta: { M: "200" } },
    { sig: "c", slot: 3, t: 120, kind: "remove_liquidity_by_range2+close_position_if_empty", position: "P", pool: "L", closed: true, solDelta: 900_000_000, tokDelta: { M: "300" } },
    { sig: "s", slot: 4, t: 130, kind: "jup_swap", solDelta: 50_000_000, tokDelta: { M: "-500" } },
  ];
  const out = run(rows, [e("P")]);
  assert.match(posLine(out), /karşılaştırılabilir: 1/);
  assert.match(realLine(out), /0\.05 SOL/); // −1 + 0.1 + 0.9 + 0.05 (the rebalance+swap once)
});

test("a position of the same token still open at the end makes the sales unattributable", () => {
  const rows = [
    { sig: "o", slot: 1, t: 0, kind: "initialize_position2", position: "P", pool: "L", created: true, solDelta: -1e9, tokDelta: {} },
    { sig: "c", slot: 2, t: 120, kind: "close_position_if_empty", position: "P", pool: "L", closed: true, solDelta: 9e8, tokDelta: { M: "500" } },
    { sig: "o2", slot: 3, t: 130, kind: "initialize_position2", position: "Q", pool: "L2", created: true, solDelta: -1e9, tokDelta: { M: "-1" } }, // never closed
    { sig: "s", slot: 4, t: 200, kind: "jup_swap", solDelta: 5e7, tokDelta: { M: "-500" } },
  ];
  const out = run(rows, [e("P")]);
  assert.match(posLine(out), /karşılaştırılabilir: 0 .*aynı token'da üst üste binen \(satış ayrıştırılamaz\): 1/);
  assert.match(out, /dönem sonunda açık pozisyon: 1/);
  assert.match(out, /atfedilemeyen satış: 1 \/ 1/);
});

test("a signature that moved two positions is not split between them", () => {
  const rows = [
    { sig: "o", slot: 1, t: 0, kind: "initialize_position2", position: "P", pool: "L", created: true, solDelta: -1e9, tokDelta: {} },
    { sig: "c", slot: 2, t: 60, kind: "close_position_if_empty", position: "P", pool: "L", closed: true, solDelta: 1e9, tokDelta: {}, positionsInTx: 2 },
    { sig: "c", slot: 2, t: 60, kind: "close_position_if_empty", position: "R", pool: "L", closed: true, solDelta: null, tokDelta: null, walletRow: false, positionsInTx: 2 },
  ];
  const out = run(rows, [e("P")]);
  assert.match(posLine(out), /başka pozisyonla ortak imza \(bölünemez\): 1/);
});

test("a position that only has a FAILED open never existed: it does not block the token's sales", () => {
  const rows = [
    { sig: "f", slot: 1, t: 0, kind: "initialize_position2", position: "X", pool: "L2", created: true, err: "{\"InstructionError\":[0,\"Custom\"]}", solDelta: -5000, tokDelta: {} },
    { sig: "o", slot: 2, t: 10, kind: "initialize_position2", position: "P", pool: "L", created: true, solDelta: -1e9, tokDelta: {} },
    { sig: "c", slot: 3, t: 120, kind: "close_position_if_empty", position: "P", pool: "L", closed: true, solDelta: 9e8, tokDelta: { M: "500" } },
    { sig: "s", slot: 4, t: 130, kind: "jup_swap", solDelta: 5e7, tokDelta: { M: "-500" } },
  ];
  const out = run(rows, [e("P")]);
  assert.match(posLine(out), /karşılaştırılabilir: 1/);
  assert.match(out, /dönem sonunda açık pozisyon: 0/);
});

