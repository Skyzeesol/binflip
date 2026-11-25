// Per-position sequences: how amounts carry across SOL<->TOKEN flips.
import fs from "node:fs";
const rows = fs.readFileSync("data/rows.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => !r.err && r.position).sort((a, b) => a.slot - b.slot);
const B = (v) => BigInt(v ?? 0);
const byPos = new Map(); for (const r of rows) { const a = byPos.get(r.position) ?? []; a.push(r); byPos.set(r.position, a); }
const cnt = new Map(); const inc = (k) => cnt.set(k, (cnt.get(k) ?? 0) + 1);
let shown = 0;
for (const [pos, seq] of byPos) {
  for (const r of seq) {
    if (r.kind !== "rebalance_liquidity") continue;
    const wSide = B(r.xW) > 0n && B(r.yW) > 0n ? "mixW" : B(r.xW) > 0n ? "tokW" : "solW";
    const aSide = B(r.xA) > 0n ? "tokA" : "solA";
    const lotY = r.adds.reduce((s, a) => s + B(a.y0) * BigInt(a.hi - a.lo + 1), 0n);
    let note;
    if (aSide === "solA") note = B(r.yA) === lotY ? "yA=sum(y0)" : "yA!=sum(y0)";
    else note = B(r.xA) === B(r.xW) ? "xA=xW" : B(r.xA) < B(r.xW) ? "xA<xW" : "xA>xW";
    inc(`${wSide}->${aSide} ${note}`);
    if (shown < 6 && wSide === "mixW") { shown++; console.log(pos.slice(0, 6), r.kind, "W x/y", r.xW, r.yW, "A x/y", r.xA, r.yA, "fee", r.xF, r.yF, "adds", JSON.stringify(r.adds)); }
  }
}
console.log([...cnt].sort((a, b) => b[1] - a[1]));
