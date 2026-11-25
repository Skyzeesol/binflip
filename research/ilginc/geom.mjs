// Phase 2 stats: rebalance trigger distance, new-range geometry, lot sizes, sides.
import fs from "node:fs";
const rows = fs.readFileSync("data/rows.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l));
const cnt = (arr) => { const m = new Map(); for (const k of arr) m.set(k, (m.get(k) ?? 0) + 1); return [...m].sort((a, b) => b[1] - a[1]); };
const pr = (title, arr, top = 12) => console.log(title.padEnd(34), cnt(arr).slice(0, top).map(([k, v]) => `${k}:${v}`).join("  "));
console.log("kinds:"); for (const [k, v] of cnt(rows.map((r) => (r.err ? "FAIL " : "") + r.kind)).slice(0, 14)) console.log("  ", v, k);
const rb = rows.filter((r) => r.kind === "rebalance_liquidity" && !r.err);
const side = (r) => (BigInt(r.xA ?? 0) > 0n && BigInt(r.yA ?? 0) > 0n ? "both" : BigInt(r.xA ?? 0) > 0n ? "TOKEN" : BigInt(r.yA ?? 0) > 0n ? "SOL" : "none");
console.log("\nrebalances ok:", rb.length, " pools:", new Set(rb.map((r) => r.pool)).size, " positions:", new Set(rb.map((r) => r.position)).size);
pr("side added", rb.map(side));
// trigger: where was active relative to OLD range
pr("trigger: active - oldMax (>0 up)", rb.map((r) => (r.active > r.oldMax ? "+" + (r.active - r.oldMax) : r.active < r.oldMin ? "-" + (r.oldMin - r.active) : "in")));
pr("old width", rb.map((r) => r.oldMax - r.oldMin + 1));
pr("new width", rb.map((r) => r.newMax - r.newMin + 1));
pr("new range rel active [lo,hi]", rb.map((r) => `[${r.newMin - r.active},${r.newMax - r.active}]|${side(r)}`));
pr("slippage", rb.map((r) => r.slip)); pr("claim", rb.map((r) => r.claim)); pr("shrink", rb.map((r) => r.shrink));
pr("add y0 (SOL lot)", rb.filter((r) => side(r) === "SOL").map((r) => r.adds.map((a) => a.y0).join("/")));
pr("add shape dx/dy/flag", rb.map((r) => r.adds.map((a) => `${a.dx}/${a.dy}/${a.flag}/${a.fx}`).join(" ")));
pr("token side: x0", rb.filter((r) => side(r) === "TOKEN").map((r) => (r.adds[0].x0 === r.xW ? "x0=withdrawn" : "x0!=w")));
pr("removes bps", rb.map((r) => r.removes.map((x) => x[2]).join("/")));
pr("SOL: yA vs yW", rb.filter((r) => side(r) === "SOL").map((r) => (BigInt(r.yA) === BigInt(r.yW) ? "eq" : BigInt(r.yA) < BigInt(r.yW) ? "yA<yW" : "yA>yW")));
const pools = JSON.parse(fs.readFileSync("data/pools.json", "utf8"));
const byStep = new Map();
for (const r of rb) { const bs = pools[r.pool]?.binStep; const k = `${bs}`; const m = byStep.get(k) ?? []; m.push(r.newMax - r.newMin + 1); byStep.set(k, m); }
console.log("\nbin_step -> new width (count)   [hypothesis w=round(100/binStep)]");
for (const [bs, ws] of [...byStep].sort((a, b) => +a[0] - +b[0])) console.log("  bs", bs.padEnd(4), "w*", String(Math.max(1, Math.round(100 / +bs))).padEnd(3), cnt(ws).map(([k, v]) => `${k}:${v}`).join(" "));
pr("base fee %", [...new Set(rb.map((r) => r.pool))].map((p) => pools[p]?.baseFee));
pr("pair Y token", [...new Set(rb.map((r) => r.pool))].map((p) => pools[p]?.y?.slice(0, 4)));
