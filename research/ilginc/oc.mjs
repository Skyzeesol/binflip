// Opens, closes and swaps: shape, lot, range, and what happens around them.
import fs from "node:fs";
const rows = fs.readFileSync("data/rows.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => !r.err).sort((a, b) => a.slot - b.slot);
const pools = JSON.parse(fs.readFileSync("data/pools.json", "utf8"));
const J = (o) => JSON.stringify(o);
console.log("== opens");
for (const r of rows.filter((r) => r.kind.startsWith("initialize_position")).slice(0, 8)) {
  const p = r.addArgs?.liquidity_parameter ?? r.addArgs; const sp = p?.strategy_parameters;
  console.log(pools[r.pool]?.name, "bs", pools[r.pool]?.binStep, "active", r.active, "init", J(r.initArgs), "addX/Y", r.addX, r.addY, "strategy", J(sp), "maxSlip", p?.max_active_bin_slippage, "activeArg", p?.active_id, "fee", r.fee);
}
console.log("== closes");
for (const r of rows.filter((r) => r.closed).slice(0, 6)) console.log(pools[r.pool]?.name, "active", r.active, "remX/Y", r.remX, r.remY, "feeX/Y", r.feeX, r.feeY, "tok", J(r.tokDelta), "sol", r.solDelta);
console.log("== dlmm swaps by wallet");
for (const r of rows.filter((r) => r.kind === "swap" || r.kind === "swap2").slice(0, 6)) console.log(r.kind, pools[r.pool]?.name ?? r.pool, "tok", J(r.tokDelta), "sol", r.solDelta, "fee", r.fee);
console.log("== jupiter");
for (const r of rows.filter((r) => r.kind === "jup_swap").slice(0, 6)) console.log("tok", J(r.tokDelta), "sol", r.solDelta, "fee", r.fee, "cu", r.cu);
