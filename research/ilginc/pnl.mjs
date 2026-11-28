// Position accounting for the exit study. For every position, after every event, in SOL:
//   pnl  = position value + fees claimed + net SOL/token returned to the wallet − SOL put in
//   inv  = pnl − fees                (inventory result: what price moves did to the capital)
// Token amounts are valued at the active bin's price: price(bin) = (1 + binStep/1e4)^bin, which
// is Y raw units (lamports) per X raw unit, so no decimals are needed.
// Output: data/pnl.jsonl (one line per closed position) + a report of what the wallet saw at close.
import fs from "node:fs";

const rows = fs.readFileSync("data/rows.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => !r.err && r.position).sort((a, b) => a.slot - b.slot);
const pools = JSON.parse(fs.readFileSync("data/pools.json", "utf8"));
const B = (v) => Number(BigInt(v ?? 0));
const px = (bs, bin) => Math.pow(1 + bs / 1e4, bin); // lamports per raw token unit

const pos = new Map();
const closed = [];
let skippedNoLot = 0; // opened with tokens or empty: no SOL lot to measure against
for (const r of rows) {
  const bs = pools[r.pool]?.binStep;
  if (!bs) continue;
  let p = pos.get(r.position);
  if (r.created) {
    p = { position: r.position, pool: r.pool, name: pools[r.pool]?.name, bs, t0: r.t, lot: B(r.addY), solIn: 0, tokIn: 0, fees: 0, x: 0, y: 0, path: [], n: 0, maxPnl: -Infinity, minPnl: Infinity, tMax: r.t };
    pos.set(r.position, p);
  }
  if (!p) continue; // opened before our data window
  const price = r.active != null ? px(bs, r.active) : null;
  if (r.created) {
    p.solIn += B(r.addY); p.tokIn += B(r.addX); // tokIn: raw token units, valued at the price of the moment
    p.tokInSol = (p.tokInSol ?? 0) + (price ? B(r.addX) * price : 0);
    p.x = B(r.addX); p.y = B(r.addY);
  } else if (r.kind === "rebalance_liquidity" && r.newMin != null) {
    p.lastMove = r.t;
    // wallet → position (positive) or position → wallet (negative), each side separately
    p.solIn += B(r.yA) - B(r.yW);
    p.tokInSol = (p.tokInSol ?? 0) + (B(r.xA) - B(r.xW)) * price;
    p.fees += B(r.yF) + B(r.xF) * price;
    p.x = B(r.xA); p.y = B(r.yA);
    p.n++;
  } else if (r.closed) {
    p.solIn -= B(r.remY);
    p.tokInSol = (p.tokInSol ?? 0) - B(r.remX) * (price ?? 0);
    p.fees += B(r.feeY) + B(r.feeX) * (price ?? 0);
    p.x = 0; p.y = 0;
  } else continue;
  const value = p.y + (price ? p.x * price : 0);
  const pnl = value + p.fees - p.solIn - (p.tokInSol ?? 0);
  const pct = p.lot > 0 ? (pnl / p.lot) * 100 : null;
  p.path.push([r.t, pct, p.lot > 0 ? (p.fees / p.lot) * 100 : null]);
  if (pct != null && pct > p.maxPnl) { p.maxPnl = pct; p.tMax = r.t; }
  if (pct != null && pct < p.minPnl) p.minPnl = pct;
  if (r.closed && !(p.lot > 0)) { skippedNoLot++; pos.delete(r.position); continue; }
  if (r.closed) {
    const fees = (p.fees / p.lot) * 100;
    // fee earned in the last 10 / 30 minutes before close, % of lot
    const feeAt = (t) => { let f = 0; for (const [tt, , ff] of p.path) if (tt <= t) f = ff; return f; };
    closed.push({
      position: p.position, pool: p.pool, name: p.name, bs: p.bs, lotSol: p.lot / 1e9, heldMin: +((r.t - p.t0) / 60).toFixed(1), rebalances: p.n,
      pnlPct: +pct.toFixed(2), feePct: +fees.toFixed(2), invPct: +(pct - fees).toFixed(2),
      maxPnlPct: +p.maxPnl.toFixed(2), minPnlPct: +p.minPnl.toFixed(2), fromPeakPct: +(pct - p.maxPnl).toFixed(2), minSincePeak: +((r.t - p.tMax) / 60).toFixed(1),
      fee10Pct: +(fees - feeAt(r.t - 600)).toFixed(3), fee30Pct: +(fees - feeAt(r.t - 1800)).toFixed(3),
      minSinceMove: +((r.t - (p.lastMove ?? p.t0)) / 60).toFixed(1),
      // fee speed in the last 30 min vs the position's average speed (1 = unchanged, 0 = dried up)
      feeSpeed30: r.t - p.t0 > 3600 && fees > 0 ? +(((fees - feeAt(r.t - 1800)) / 30) / (fees / ((r.t - p.t0) / 60))).toFixed(2) : null,
      sideAtClose: B(r.remX) > 0 && B(r.remY) === 0 ? "token" : B(r.remY) > 0 && B(r.remX) === 0 ? "sol" : "mixed",
    });
    pos.delete(r.position);
  }
}
fs.writeFileSync("data/pnl.jsonl", closed.map((c) => JSON.stringify(c)).join("\n") + "\n");

const q = (a, ps = [0.1, 0.25, 0.5, 0.75, 0.9]) => { const s = a.filter((x) => x != null && Number.isFinite(x)).sort((x, y) => x - y); if (!s.length) return "-"; return ps.map((p) => s[Math.min(s.length - 1, Math.floor(p * s.length))]).join(" | "); };
const show = (label, key, set = closed) => console.log(label.padEnd(44), q(set.map((c) => c[key])));
console.log(`kapanan pozisyon: ${closed.length} (+${skippedNoLot} SOL lotsuz, dışarıda)   (q10 | q25 | medyan | q75 | q90, % = lotun yüzdesi)`);
show("kâr/zarar % (fee dahil)", "pnlPct");
show("toplanan fee %", "feePct");
show("envanter sonucu % (kâr/zarar − fee)", "invPct");
show("zirve kâr/zarar %", "maxPnlPct");
show("dip kâr/zarar %", "minPnlPct");
show("kapanışta zirveden uzaklık % (puan)", "fromPeakPct");
show("zirveden bu yana geçen dk", "minSincePeak");
show("son 10 dk fee %", "fee10Pct");
show("son 30 dk fee %", "fee30Pct");
show("tutma dk", "heldMin");
show("son taşımadan bu yana dk", "minSinceMove");
show("son 30 dk fee hızı / ortalama hız (>1 saat)", "feeSpeed30");
const still = closed.filter((c) => c.rebalances === 0), moved = closed.filter((c) => c.rebalances > 0);
console.log(`\nhiç taşınmadan kapanan: ${still.length}  (tutma dk: ${q(still.map((c) => c.heldMin))})`);
console.log(`en az 1 kez taşınan: ${moved.length}`);
console.log("  son taşımadan bu yana dk".padEnd(44), q(moved.map((c) => c.minSinceMove)));
console.log("  son 30 dk fee hızı / ortalama".padEnd(44), q(moved.map((c) => c.feeSpeed30)));
const win = closed.filter((c) => c.pnlPct > 0).length;
console.log(`\nkârla kapanan: ${win} / ${closed.length} (%${((win / closed.length) * 100).toFixed(1)})   toplam kâr/zarar: ${closed.reduce((s, c) => s + (c.pnlPct * c.lotSol) / 100, 0).toFixed(2)} SOL   toplam fee: ${closed.reduce((s, c) => s + (c.feePct * c.lotSol) / 100, 0).toFixed(2)} SOL`);
console.log("kapanışta taraf:", Object.entries(closed.reduce((m, c) => ((m[c.sideAtClose] = (m[c.sideAtClose] ?? 0) + 1), m), {})).map(([k, v]) => `${k}:${v}`).join("  "));

// Candidate exit rules: how many closes does each explain, and how often would it have fired earlier?
console.log("\n## Aday çıkış kuralları: kapanışta koşul sağlanıyor mu?");
const rules = [
  ["kâr ≥ +%3", (c) => c.pnlPct >= 3], ["kâr ≥ +%5", (c) => c.pnlPct >= 5], ["zarar ≤ −%5", (c) => c.pnlPct <= -5], ["zarar ≤ −%10", (c) => c.pnlPct <= -10],
  ["envanter ≤ −%5", (c) => c.invPct <= -5], ["zirveden ≥ 3 puan düşüş", (c) => c.fromPeakPct <= -3], ["zirveden ≥ 5 puan düşüş", (c) => c.fromPeakPct <= -5],
  ["son 30 dk fee < %0,1", (c) => c.fee30Pct < 0.1], ["son 10 dk fee < %0,05", (c) => c.fee10Pct < 0.05], ["kapanışta token tarafında", (c) => c.sideAtClose === "token"],
];
for (const [name, f] of rules) { const n = closed.filter(f).length; console.log(name.padEnd(30), `${n} / ${closed.length} (%${((n / closed.length) * 100).toFixed(1)})`); }
