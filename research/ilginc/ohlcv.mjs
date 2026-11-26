// Backfill GeckoTerminal 1-minute candles around every historical open/close of the wallet.
// Output: data/ohlcv/<pool>.json = [[t, o, h, l, c, volUsd], ...] ascending. Resumable.
// Public API: 30 req/min, minute data for the last 180 days. Usage: node ohlcv.mjs [maxPools]
import fs from "node:fs";
const BEFORE_SEC = 3 * 3600; // history needed before the first event in a pool
const AFTER_SEC = 3600;
const GAP_MS = 2200; // ≤ 27 req/min
const rows = fs.readFileSync("data/rows.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l));
const spans = new Map();
for (const r of rows) {
  if (r.err || !r.pool || !(r.created || r.closed)) continue;
  const s = spans.get(r.pool) ?? [Infinity, 0];
  spans.set(r.pool, [Math.min(s[0], r.t), Math.max(s[1], r.t)]);
}
fs.mkdirSync("data/ohlcv", { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url) {
  for (let i = 0; ; i++) {
    const r = await fetch(url, { signal: AbortSignal.timeout(30000) }).catch((e) => ({ ok: false, status: 0, e }));
    if (r.ok) return r.json();
    if (r.status === 404) return null;
    if (r.status === 401) return { tooOld: true };
    if (i >= 8) throw new Error(`gecko ${r.status}`);
    await sleep(Math.min(60000, 5000 * 2 ** i)); // 429 / network: back off
  }
}
const pools = [...spans].sort((a, b) => a[1][0] - b[1][0]).slice(0, process.argv[2] ? +process.argv[2] : undefined);
let reqs = 0, done = 0;
for (const [pool, [first, last]] of pools) {
  const file = `data/ohlcv/${pool}.json`;
  if (fs.existsSync(file)) { done++; continue; }
  const want = first - BEFORE_SEC;
  let before = last + AFTER_SEC;
  const candles = new Map();
  for (;;) {
    const j = await get(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${pool}/ohlcv/minute?aggregate=1&limit=1000&before_timestamp=${before}&currency=usd`);
    reqs++;
    await sleep(GAP_MS);
    const list = j?.data?.attributes?.ohlcv_list ?? [];
    for (const c of list) candles.set(c[0], c);
    if (!list.length || j?.tooOld) break;
    const oldest = list.at(-1)[0];
    if (oldest <= want || oldest >= before) break;
    before = oldest;
  }
  fs.writeFileSync(file, JSON.stringify([...candles.values()].sort((a, b) => a[0] - b[0])));
  done++;
  if (done % 10 === 0) console.log(new Date().toISOString(), `pools ${done}/${pools.length} requests ${reqs}`);
}
console.log("done", done, "pools,", reqs, "requests");
