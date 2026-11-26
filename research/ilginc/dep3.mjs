// For SOL-side deposits where yA > yW: is the extra the fee just claimed (yF), or accumulated fees since last deposit?
import fs from "node:fs";
const rows = fs.readFileSync("data/rows.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => !r.err && r.position).sort((a, b) => a.slot - b.slot);
const B = (v) => BigInt(v ?? 0);
const near = (a, b, ppm = 1000n) => (a > b ? a - b : b - a) * 1000000n <= (a > b ? a : b) * ppm;
const c = new Map(); const inc = (k) => c.set(k, (c.get(k) ?? 0) + 1);
const ex = [];
for (const r of rows) {
  if (r.kind !== "rebalance_liquidity" || B(r.xA) > 0n || B(r.xW) > 0n) continue;
  const yW = B(r.yW), yA = B(r.yA), yF = B(r.yF);
  if (near(yA, yW)) { inc("yA=yW"); continue; }
  if (near(yA, yW + yF)) inc("yA=yW+yF (bu claim'i compound)");
  else if (yA > yW) { inc("yA>yW başka"); if (ex.length < 10) ex.push({ yW: r.yW, yF: r.yF, yA: r.yA, extra: (yA - yW).toString(), solPre: r.solPre }); }
  else inc("yA<yW");
}
console.log([...c].sort((a, b) => b[1] - a[1]));
for (const e of ex) console.log(e);
