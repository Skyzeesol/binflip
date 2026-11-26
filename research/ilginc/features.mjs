// Per-event market features from 1-minute candles (data/ohlcv), for every open and close,
// plus a control sample: the same pool 2 h before each open (when the wallet had no position there).
// Output: data/features.jsonl and a quantile report (opens vs control, closes vs mid-position).
import fs from "node:fs";

const rows = fs.readFileSync("data/rows.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => !r.err).sort((a, b) => a.slot - b.slot);
const pools = fs.existsSync("data/pools.json") ? JSON.parse(fs.readFileSync("data/pools.json", "utf8")) : {};
const cache = new Map();
function candles(pool) {
  if (!cache.has(pool)) {
    const f = `data/ohlcv/${pool}.json`;
    const list = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
    cache.set(pool, list && list.length ? { list, byMin: new Map(list.map((c) => [c[0], c])) } : null);
  }
  return cache.get(pool);
}

/** Features over the minutes strictly before t (the decision cannot see its own minute). */
function feat(pool, t) {
  const c = candles(pool);
  if (!c) return null;
  const m0 = Math.floor(t / 60) * 60; // event minute (excluded)
  const at = (k) => c.byMin.get(m0 - 60 * k); // k minutes before
  if (c.list[0][0] > m0 - 3600 || c.list.at(-1)[0] < m0 - 120) return null; // need 60 min of history
  const vol = (n) => { let s = 0; for (let k = 1; k <= n; k++) s += at(k)?.[5] ?? 0; return s; };
  const lastClose = (k) => { for (let j = k; j < k + 240; j++) { const x = at(j); if (x) return x[4]; } return null; }; // carry forward over empty minutes
  const p1 = lastClose(1), p5 = lastClose(6), p15 = lastClose(16), p60 = lastClose(61);
  let hi = -Infinity, lo = Infinity, active = 0;
  for (let k = 1; k <= 15; k++) { const x = at(k); if (x) { hi = Math.max(hi, x[2]); lo = Math.min(lo, x[3]); active++; } }
  const v5 = vol(5), v60 = vol(60);
  const pct = (a, b) => (a && b ? +(((a / b) - 1) * 100).toFixed(2) : null);
  return {
    v1: +vol(1).toFixed(0), v5: +v5.toFixed(0), v15: +vol(15).toFixed(0), v60: +v60.toFixed(0),
    spike5: v60 > 0 ? +((v5 / (v60 / 12))).toFixed(2) : null, // 5-min volume vs the hour's 5-min average
    pc5: pct(p1, p5), pc15: pct(p1, p15), pc60: pct(p1, p60),
    range15: hi > 0 && lo < Infinity ? +(((hi / lo) - 1) * 100).toFixed(2) : null,
    activeMin15: active, // minutes with trades in the last 15
  };
}

const out = fs.createWriteStream("data/features.jsonl");
const sets = { open: [], control: [], close: [], mid: [] };
const openAt = new Map(); // position -> open row
const busy = new Map(); // pool -> [[from,to],...] periods with a position
for (const r of rows) {
  if (r.created) openAt.set(r.position, r);
  if (r.closed && openAt.has(r.position)) {
    const o = openAt.get(r.position);
    const a = busy.get(r.pool) ?? []; a.push([o.t, r.t]); busy.set(r.pool, a);
  }
}
const isBusy = (pool, t) => (busy.get(pool) ?? []).some(([a, b]) => t >= a && t <= b);
for (const r of rows) {
  if (!r.pool) continue;
  const meta = { pool: r.pool, name: pools[r.pool]?.name, binStep: pools[r.pool]?.binStep, baseFee: pools[r.pool]?.baseFee, t: r.t };
  if (r.created) {
    const f = feat(r.pool, r.t);
    if (f) { const e = { kind: "open", ...meta, lotSol: Number(BigInt(r.addY ?? 0)) / 1e9, ...f }; sets.open.push(e); out.write(JSON.stringify(e) + "\n"); }
    const tc = r.t - 7200;
    if (!isBusy(r.pool, tc)) { const g = feat(r.pool, tc); if (g) { const e = { kind: "control", ...meta, t: tc, ...g }; sets.control.push(e); out.write(JSON.stringify(e) + "\n"); } }
  }
  if (r.closed && openAt.has(r.position)) {
    const o = openAt.get(r.position);
    const f = feat(r.pool, r.t);
    if (f) {
      const c = candles(r.pool), po = c && c.list.filter((x) => x[0] < Math.floor(o.t / 60) * 60).at(-1)?.[4], pc = c && c.list.filter((x) => x[0] < Math.floor(r.t / 60) * 60).at(-1)?.[4];
      const e = { kind: "close", ...meta, heldMin: +((r.t - o.t) / 60).toFixed(1), pcHeld: po && pc ? +(((pc / po) - 1) * 100).toFixed(2) : null, ...f };
      sets.close.push(e); out.write(JSON.stringify(e) + "\n");
    }
    const tm = Math.floor((o.t + r.t) / 2); // a moment the wallet chose to stay
    if (r.t - o.t > 600) { const g = feat(r.pool, tm); if (g) { const e = { kind: "mid", ...meta, t: tm, ...g }; sets.mid.push(e); out.write(JSON.stringify(e) + "\n"); } }
  }
}
out.end();

const keys = ["v5", "v60", "spike5", "pc5", "pc15", "pc60", "range15", "activeMin15"];
const q = (a) => { const s = a.filter((x) => x != null && Number.isFinite(x)).sort((x, y) => x - y); if (!s.length) return "-"; const g = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))]; return `${g(0.1)} | ${g(0.25)} | ${g(0.5)} | ${g(0.75)} | ${g(0.9)}`; };
const show = (title, a, b, an, bn) => {
  console.log(`\n## ${title}  (${an}: ${a.length}, ${bn}: ${b.length})   q10 | q25 | medyan | q75 | q90`);
  for (const k of keys) console.log(`${k.padEnd(12)} ${an.padEnd(7)} ${q(a.map((e) => e[k]))}\n${"".padEnd(12)} ${bn.padEnd(7)} ${q(b.map((e) => e[k]))}`);
};
show("GİRİŞ: açılış anı vs aynı havuzda 2 saat önce", sets.open, sets.control, "açılış", "kontrol");
show("ÇIKIŞ: kapanış anı vs pozisyonun ortası", sets.close, sets.mid, "kapanış", "orta");
console.log("\nkapanış: tutma süresi dk", q(sets.close.map((e) => e.heldMin)), "| tutarken fiyat değişimi %", q(sets.close.map((e) => e.pcHeld)));
const lots = new Map(); for (const e of sets.open) { const k = e.lotSol >= 6.5 ? "7" : e.lotSol >= 1.5 && e.lotSol < 2.5 ? "2" : e.lotSol >= 0.9 && e.lotSol < 1.1 ? "1" : "diğer"; const a = lots.get(k) ?? []; a.push(e); lots.set(k, a); }
console.log("\n## LOT kademesine göre açılış anı (v60, spike5, range15)");
for (const [k, a] of [...lots].sort()) console.log(`lot ${k.padEnd(6)} n=${String(a.length).padEnd(4)} v60 ${q(a.map((e) => e.v60))}   spike5 ${q(a.map((e) => e.spike5))}   range15 ${q(a.map((e) => e.range15))}`);
