// Cache Meteora pool metadata (bin_step, fees, tokens) for every pool seen in rows.jsonl.
import fs from "node:fs";
const file = "data/pools.json";
const cache = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
const pools = [...new Set(fs.readFileSync("data/rows.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l).pool).filter(Boolean))];
for (const p of pools.filter((p) => !cache[p])) {
  const r = await fetch(`https://dlmm.datapi.meteora.ag/pools/${p}`);
  if (!r.ok) { cache[p] = { missing: r.status }; continue; }
  const j = await r.json();
  cache[p] = { name: j.name, binStep: j.pool_config?.bin_step, baseFee: j.pool_config?.base_fee_pct, maxFee: j.pool_config?.max_fee_pct, x: j.token_x?.address, xDec: j.token_x?.decimals, y: j.token_y?.address, created: j.created_at, launchpad: j.launchpad ?? null };
  await new Promise((r) => setTimeout(r, 150));
}
fs.writeFileSync(file, JSON.stringify(cache, null, 1)); console.log("pools", Object.keys(cache).length);
