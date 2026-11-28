// node --test research/ilginc/features.test.mjs — data gaps vs quiet minutes; control points.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const here = path.dirname(new URL(import.meta.url).pathname);
function run(rows, candles, cov) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feat-"));
  fs.mkdirSync(path.join(dir, "ohlcv"));
  fs.writeFileSync(path.join(dir, "pools.json"), JSON.stringify({ L: { name: "T-SOL", binStep: 100 } }));
  fs.writeFileSync(path.join(dir, "rows.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "ohlcv", "L.json"), JSON.stringify(candles));
  if (cov) fs.writeFileSync(path.join(dir, "ohlcv", "L.cov.json"), JSON.stringify(cov));
  execFileSync("node", [path.join(here, "features.mjs")], { env: { ...process.env, DATA_DIR: dir }, encoding: "utf8" });
  return fs.readFileSync(path.join(dir, "features.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
const T = 100 * 3600; // open time (minute-aligned)
const c = (t, v) => [t, 1, 1, 1, 1, v];
const span = (from, to, every, v) => { const out = []; for (let t = from; t < to; t += every) out.push(c(t, v)); return out; };

test("one candle in the hour and no coverage info: volume features unknown, not a 12x spike", () => {
  const rows = [{ slot: 1, t: T, pool: "L", position: "P", created: true, addY: "1000000000" }];
  const candles = [c(T - 7200 - 3700, 1), c(T - 300, 100), c(T + 60, 1)]; // history span ok, a single traded minute
  const [open] = run(rows, candles, null).filter((e) => e.kind === "open");
  assert.equal(open.spike5, null);
  assert.equal(open.v60, null);
});

test("with coverage info a quiet minute IS zero volume", () => {
  const rows = [{ slot: 1, t: T, pool: "L", position: "P", created: true, addY: "1000000000" }];
  const candles = [...span(T - 3700, T - 600, 600, 10), c(T - 300, 100), c(T + 60, 1)];
  const [open] = run(rows, candles, [[T - 4000, T + 120]]).filter((e) => e.kind === "open");
  assert.notEqual(open.spike5, null);
});

test("a control point inside a position that is still open at the end is not 'no position'", () => {
  // Q opened 3 h before P and never closed (in the same pool): P's control point (2 h before) falls inside Q
  const rows = [
    { slot: 1, t: T - 3 * 3600, pool: "L", position: "Q", created: true, addY: "1" },
    { slot: 2, t: T, pool: "L", position: "P", created: true, addY: "1000000000" },
  ];
  const candles = span(T - 4 * 3600 - 3700, T + 120, 60, 5);
  const out = run(rows, candles, [[T - 5 * 3600, T + 120]]);
  assert.equal(out.filter((e) => e.kind === "control" && e.t === T - 7200).length, 0);
});
