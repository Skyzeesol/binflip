import fs from "node:fs";
const rows = fs.readFileSync("data/rows.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => !r.err && r.kind === "rebalance_liquidity" && BigInt(r.xW ?? 0) > 0n);
const pools = JSON.parse(fs.readFileSync("data/pools.json", "utf8"));
const B = (v) => BigInt(v ?? 0); const c = new Map(); const inc = (k) => c.set(k, (c.get(k) ?? 0) + 1);
let ex = 0;
for (const r of rows) {
  const x = pools[r.pool]?.x; const d = B(r.tokDelta?.[x]);
  const net = B(r.xW) + B(r.xF) - B(r.xA); // tokens left in wallet from this tx
  inc(net === d ? "walletDelta == xW+xF-xA" : "walletDelta != (xW+xF-xA)");
  inc(B(r.xA) === B(r.xW) + B(r.xF) ? "xA == xW+xF (compound token)" : B(r.xA) > B(r.xW) + B(r.xF) ? "xA > xW+xF (pull from wallet)" : "xA < xW+xF (keep some)");
  if (ex++ < 4) console.log(JSON.stringify({ xW: r.xW, xF: r.xF, xA: r.xA, yF: r.yF, walletTokDelta: d.toString(), adds: r.adds, maxDepX: r.maxDepX }));
}
console.log([...c]);
