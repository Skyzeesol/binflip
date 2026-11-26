// Replay the core mm engine on every historical BviQ rebalance: given the old range and the
// active bin the leader saw, does mmDecide produce exactly the leader's new range and side?
import fs from "node:fs";
import { mmDecide } from "../../packages/core/dist/mm/engine.js";
const rows = fs.readFileSync("data/rows.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => !r.err && r.kind === "rebalance_liquidity" && r.newMin != null);
const pools = JSON.parse(fs.readFileSync("data/pools.json", "utf8"));
const c = new Map(); const inc = (k) => c.set(k, (c.get(k) ?? 0) + 1); const bad = [];
for (const r of rows) {
  const bs = pools[r.pool]?.binStep; if (!bs) { inc("binStep yok"); continue; }
  const side = BigInt(r.xA ?? 0) > 0n ? "token" : "sol";
  const d = mmDecide({ lower: r.oldMin, upper: r.oldMax, side: "sol" }, r.active, bs);
  if (d.kind !== "rebalance") { inc("motor: bekle (lider taşıdı)"); if (bad.length < 5) bad.push(r.sig); continue; }
  const ok = d.next.lower === r.newMin && d.next.upper === r.newMax && d.next.side === side;
  inc(ok ? "birebir" : "farklı"); if (!ok && bad.length < 5) bad.push(r.sig);
}
console.log("rebalance", rows.length, [...c]);
if (bad.length) console.log("örnek:", bad);
