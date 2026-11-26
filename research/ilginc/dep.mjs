// What decides the SOL re-deposit (yA) in SOL-side rebalances?
import fs from "node:fs";
const rows = fs.readFileSync("data/rows.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => !r.err && r.kind === "rebalance_liquidity" && BigInt(r.yA ?? 0) > 0n && BigInt(r.xA ?? 0) === 0n);
const pools = JSON.parse(fs.readFileSync("data/pools.json", "utf8"));
const B = (v) => BigInt(v ?? 0); const c = new Map(); const inc = (k) => c.set(k, (c.get(k) ?? 0) + 1);
const close = (a, b) => (a > b ? a - b : b - a) * 1000n <= (a > b ? a : b); // within 0.1%
for (const r of rows) {
  const yA = B(r.yA), yW = B(r.yW), yF = B(r.yF), xW = B(r.xW);
  if (xW > 0n) { inc("mixed withdraw"); continue; }
  if (close(yA, yW)) inc("yA = yW (hepsi geri)");
  else if (close(yA, yW - yF)) inc("yA = yW - yF (fee hariç hepsi)");
  else if (yA < yW) inc(yA * 100n < yW * 99n ? "yA < yW %1+ (cüzdana)" : "yA < yW <%1");
  else inc(yA * 99n > yW * 100n ? "yA > yW %1+ (cüzdandan ek)" : "yA > yW <%1");
}
console.log([...c].sort((a, b) => b[1] - a[1]));
// Does yW include the claimed fee? compare against Rebalancing fields: in DLMM rebalance, y_withdrawn excludes fees (fees reported separately).
// Show a few 'yA < yW' and 'yA > yW' examples with lot hints
let k = 0;
for (const r of rows) { const yA = B(r.yA), yW = B(r.yW); if (yA !== yW && k++ < 8) console.log(pools[r.pool]?.name, "yW", r.yW, "yF", r.yF, "yA", r.yA, "solPre", r.solPre); }
// lot vs pool attributes at open
const opens = fs.readFileSync("data/rows.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => !r.err && r.created);
const m = new Map(); for (const r of opens) { const lot = (Number(B(r.addY)) / 1e9).toFixed(0); const key = `bs${pools[r.pool]?.binStep}|fee${pools[r.pool]?.baseFee}`; const e = m.get(key) ?? {}; e[lot] = (e[lot] ?? 0) + 1; m.set(key, e); }
console.log("lot by bin_step|baseFee:"); for (const [k2, v] of [...m].sort()) console.log(" ", k2.padEnd(16), JSON.stringify(v));
