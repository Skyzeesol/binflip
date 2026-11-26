// Backfill GeckoTerminal 1-minute candles around every historical open/close of the wallet.
// Output: data/ohlcv/<pool>.json = [[t, o, h, l, c, volUsd], ...] ascending. Resumable.
// Public API: 30 req/min, minute data for the last 180 days. Usage: node ohlcv.mjs [maxPools]
import fs from "node:fs";
// Only the minutes each decision could see: 65 min before every open/close (plus the
// control point 2 h before each open), merged per pool. Far fewer requests than whole spans.
const BEFORE_SEC = 65 * 60;
const AFTER_SEC = 120;
const GAP_MS = 2200; // ≤ 27 req/min
const rows = fs.readFileSync("data/rows.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l));
const windows = new Map(); // pool -> [[from, to], ...] merged
for (const r of rows) {
  if (r.err || !r.pool || !(r.created || r.closed)) continue;
  const a = windows.get(r.pool) ?? [];
  a.push([r.t - BEFORE_SEC, r.t + AFTER_SEC]);
  if (r.created) a.push([r.t - 7200 - BEFORE_SEC, r.t - 7200 + AFTER_SEC]); // control point
  windows.set(r.pool, a);
}
for (const [pool, a] of windows) {
  a.sort((x, y) => x[0] - y[0]);
  const m = [];
  for (const w of a) { const last = m.at(-1); if (last && w[0] <= last[1]) last[1] = Math.max(last[1], w[1]); else m.push([...w]); }
  windows.set(pool, m);
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
const pools = [...windows].sort((a, b) => a[1][0][0] - b[1][0][0]).slice(0, process.argv[2] ? +process.argv[2] : undefined);
let reqs = 0, done = 0;
for (const [pool, wins] of pools) {
  const file = `data/ohlcv/${pool}.json`;
  if (fs.existsSync(file)) { done++; continue; }
  // Page backwards from the newest window; each page (~1000 traded minutes) usually covers
  // several windows. When a page ends inside a gap, jump straight to the next window's end.
  const candles = new Map();
  const left = [...wins]; // ascending
  let before = left.at(-1)[1];
  while (left.length) {
    const j = await get(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${pool}/ohlcv/minute?aggregate=1&limit=1000&before_timestamp=${before}&currency=usd`);
    reqs++;
    await sleep(GAP_MS);
    const list = j?.data?.attributes?.ohlcv_list ?? [];
    if (!list.length || j?.tooOld) break;
    const oldest = list.at(-1)[0];
    for (const c of list) if (left.some(([f, t]) => c[0] >= f - 60 && c[0] <= t)) candles.set(c[0], c);
    while (left.length && left.at(-1)[0] >= oldest) left.pop(); // fully covered
    if (!left.length || oldest >= before) break;
    before = Math.min(oldest, left.at(-1)[1]);
  }
  fs.writeFileSync(file, JSON.stringify([...candles.values()].sort((a, b) => a[0] - b[0])));
  done++;
  if (done % 10 === 0) console.log(new Date().toISOString(), `pools ${done}/${pools.length} requests ${reqs}`);
}
console.log("done", done, "pools,", reqs, "requests");
