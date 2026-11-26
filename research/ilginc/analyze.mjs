// Full-history parameter report for the BviQ study. Reads data/rows.jsonl + data/pools.json.
// Prints a compact text report (Turkish labels) used to update FINDINGS.md.
import fs from "node:fs";

const rows = fs.readFileSync("data/rows.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l)).sort((a, b) => a.slot - b.slot);
const pools = fs.existsSync("data/pools.json") ? JSON.parse(fs.readFileSync("data/pools.json", "utf8")) : {};
const B = (v) => BigInt(v ?? 0);
const SOL = (l) => Number(l) / 1e9;
const cnt = (arr) => { const m = new Map(); for (const k of arr) m.set(k, (m.get(k) ?? 0) + 1); return [...m].sort((a, b) => b[1] - a[1]); };
const fmt = (pairs, top = 12) => pairs.slice(0, top).map(([k, v]) => `${k}:${v}`).join("  ");
const q = (arr, ps = [0.1, 0.25, 0.5, 0.75, 0.9]) => { const s = [...arr].sort((a, b) => a - b); return ps.map((p) => s.length ? +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(3) : null); };
const day = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const H = (t) => console.log(`\n## ${t}`);
const w = (bs) => Math.max(1, Math.round(100 / bs));

H("Kapsam");
console.log("satır", rows.length, "| ilk", new Date(rows[0].t * 1000).toISOString(), "| son", new Date(rows.at(-1).t * 1000).toISOString());
console.log("imzalayan(lar):", fmt(cnt(rows.map((r) => r.signer?.slice(0, 6)))));
console.log("tür:", fmt(cnt(rows.map((r) => (r.err ? "FAIL:" : "") + r.kind)), 16));

H("Günlük");
const byDay = new Map();
for (const r of rows) { const d = byDay.get(day(r.t)) ?? { n: 0, rb: 0, fail: 0, open: 0, close: 0, fee: 0, sol: 0 }; d.n++; if (r.kind === "rebalance_liquidity") { r.err ? d.fail++ : d.rb++; } if (!r.err && r.created) d.open++; if (!r.err && r.closed) d.close++; d.fee += r.fee; d.sol += r.solDelta ?? 0; byDay.set(day(r.t), d); }
for (const [d, v] of byDay) console.log(d, `tx ${v.n} rb ${v.rb} fail ${v.fail} (${((v.fail / Math.max(1, v.rb + v.fail)) * 100).toFixed(1)}%) open ${v.open} close ${v.close} txfee ${SOL(v.fee).toFixed(3)} netSOL ${SOL(v.sol).toFixed(2)}`);

H("A. Genişlik kuralı w=max(1,round(100/bs))");
const rb = rows.filter((r) => r.kind === "rebalance_liquidity" && !r.err && r.newMin != null);
const widthOk = rb.filter((r) => pools[r.pool]?.binStep && r.newMax - r.newMin + 1 === w(pools[r.pool].binStep));
console.log("rebalance", rb.length, "| kurala uyan", widthOk.length, "| uymayan", rb.length - widthOk.length);
console.log("uymayanlar (bs:genişlik):", fmt(cnt(rb.filter((r) => !widthOk.includes(r)).map((r) => `${pools[r.pool]?.binStep}:${r.newMax - r.newMin + 1}`))));
const side = (r) => (B(r.xA) > 0n && B(r.yA) > 0n ? "both" : B(r.xA) > 0n ? "TOK" : B(r.yA) > 0n ? "SOL" : "none");
console.log("yerleşim [lo,hi]-aktif:", fmt(cnt(rb.map((r) => `${side(r)}[${r.newMin - r.active},${r.newMax - r.active}]`)).filter(([k]) => true), 10));
const placeOk = rb.filter((r) => { const ww = r.newMax - r.newMin + 1; return side(r) === "SOL" ? r.newMax === r.active - 1 : side(r) === "TOK" ? r.newMin === r.active + 1 : false; });
console.log("SOL→[a-w,a-1] / TOK→[a+1,a+w] uyan:", placeOk.length, "/", rb.length);

H("B. Tetik: rebalance anında aktif binin eski aralığa uzaklığı");
const dist = (r) => (r.active > r.oldMax ? r.active - r.oldMax : r.active < r.oldMin ? -(r.oldMin - r.active) : 0);
console.log("hepsi:", fmt(cnt(rb.map(dist)), 14));
for (const bs of [...new Set(rb.map((r) => pools[r.pool]?.binStep))].sort((a, b) => a - b)) console.log(`  bs ${bs}:`, fmt(cnt(rb.filter((r) => pools[r.pool]?.binStep === bs).map(dist)), 8));
console.log("argActive == event active:", rb.filter((r) => r.argActive === r.active).length, "/", rb.length, "| slip:", fmt(cnt(rb.map((r) => r.slip))));
const fails = rows.filter((r) => r.kind === "rebalance_liquidity" && r.err);
console.log("başarısız rebalance", fails.length, "hata:", fmt(cnt(fails.map((r) => r.err.slice(0, 60))), 4));

H("C. Miktar: pozisyon başına SOL lotu sabit mi?");
const byPos = new Map(); for (const r of rows.filter((r) => !r.err && r.position)) { const a = byPos.get(r.position) ?? []; a.push(r); byPos.set(r.position, a); }
let constLot = 0, varLot = 0; const lotVar = [];
for (const [, seq] of byPos) {
  const lots = seq.filter((r) => r.kind === "rebalance_liquidity" && side(r) === "SOL").map((r) => B(r.yA));
  if (lots.length < 2) continue;
  if (lots.every((l) => l === lots[0])) constLot++; else { varLot++; lotVar.push(lots.slice(0, 6).map((l) => SOL(l).toFixed(3)).join(",")); }
}
console.log("SOL lotu tüm rebalance'larda aynı olan pozisyon", constLot, "| değişen", varLot, "| örnek:", lotVar.slice(0, 4).join(" | "));
const tokRb = rb.filter((r) => side(r) === "TOK");
console.log("token tarafı: x0 (SOL değeri) dağılımı q10..q90:", q(tokRb.map((r) => SOL(B(r.adds[0].x0) * BigInt(r.newMax - r.newMin + 1)))));

H("D. Açılış");
const opens = rows.filter((r) => !r.err && r.created);
console.log("açılış", opens.length, "| talimat:", fmt(cnt(opens.map((r) => r.kind))));
console.log("lot SOL:", fmt(cnt(opens.map((r) => SOL(B(r.addY ?? r.yA)).toFixed(2))), 20));
console.log("lot / cüzdan SOL bakiyesi q:", q(opens.filter((r) => r.solPre).map((r) => Number(B(r.addY ?? r.yA)) / r.solPre)));
console.log("açılış yerleşimi [lo,hi]-aktif:", fmt(cnt(opens.map((r) => r.initArgs ? `[${r.initArgs.lower - r.active},${r.initArgs.lower + r.initArgs.width - 1 - r.active}]` : "?")), 8));
console.log("açılışta token var mı:", fmt(cnt(opens.map((r) => (B(r.addX) > 0n ? "token+" : "sadeceSOL")))));
const lotByDay = new Map(); for (const r of opens) { const a = lotByDay.get(day(r.t)) ?? []; a.push(SOL(B(r.addY ?? r.yA))); lotByDay.set(day(r.t), a); }
for (const [d, a] of lotByDay) console.log("  ", d, "n", a.length, "lot q:", q(a, [0.1, 0.5, 0.9]), "bakiye~", SOL(opens.filter((r) => day(r.t) === d)[0]?.solPre ?? 0).toFixed(1));

H("E. Pozisyon ömrü ve eşzamanlılık");
const life = [], nrb = []; const lifeByClose = [];
for (const [, seq] of byPos) {
  const c = seq.find((r) => r.created), z = seq.find((r) => r.closed);
  if (c && z) { life.push((z.t - c.t) / 60); nrb.push(seq.filter((r) => r.kind === "rebalance_liquidity").length); }
}
console.log("tam ömrü görülen pozisyon", life.length, "| ömür dk q:", q(life), "| rebalance sayısı q:", q(nrb));
let open = 0, maxOpen = 0; const openSamples = []; const ev = [];
for (const r of rows) { if (r.err) continue; if (r.created) ev.push([r.t, 1]); if (r.closed) ev.push([r.t, -1]); }
ev.sort((a, b) => a[0] - b[0]); let lastT = 0;
for (const [t, d] of ev) { open += d; maxOpen = Math.max(maxOpen, open); if (t - lastT > 600) { openSamples.push(open); lastT = t; } }
console.log("eşzamanlı açık pozisyon (10 dk örnek) q:", q(openSamples), "max", maxOpen);
console.log("havuz başına aynı anda pozisyon: (aynı havuzda üst üste açılış sayısı)", fmt(cnt([...byPos.values()].map((s) => s[0].pool)).map(([k, v]) => [pools[k]?.name ?? k.slice(0, 6), v]), 8));

H("G. Kapanış");
const closes = rows.filter((r) => !r.err && r.closed);
const closeSide = (r) => (B(r.remX) > 0n && B(r.remY) > 0n ? "karışık" : B(r.remX) > 0n ? "token" : B(r.remY) > 0n ? "SOL" : "boş");
console.log("kapanış", closes.length, "| çıkan taraf:", fmt(cnt(closes.map(closeSide))));
console.log("kapanışta aktif bin - aralık uzaklığı: (pozisyonun son aralığına göre)");
const lastRange = new Map(); const cd = [];
for (const r of rows) { if (r.err || !r.position) continue; if (r.newMin != null) lastRange.set(r.position, [r.newMin, r.newMax]); else if (r.initArgs) lastRange.set(r.position, [r.initArgs.lower, r.initArgs.lower + r.initArgs.width - 1]); if (r.closed && lastRange.has(r.position) && r.active != null) { const [lo, hi] = lastRange.get(r.position); cd.push(r.active > hi ? r.active - hi : r.active < lo ? -(lo - r.active) : 0); } }
console.log("  ", fmt(cnt(cd), 10));
const sells = rows.filter((r) => !r.err && (r.kind === "jup_swap" || r.kind === "swap" || r.kind === "swap2"));
let soldAfter = 0, gaps = [];
for (const c of closes.filter((r) => closeSide(r) === "token" || closeSide(r) === "karışık")) {
  const mint = Object.keys(c.tokDelta ?? {})[0]; if (!mint) continue;
  const s = sells.find((x) => x.slot > c.slot && x.tokDelta?.[mint] && B(x.tokDelta[mint]) < 0n && x.t - c.t < 3600);
  if (s) { soldAfter++; gaps.push(s.t - c.t); }
}
console.log("token'lı kapanıştan sonra aynı token satışı (1 saat içinde):", soldAfter, "| gecikme sn q:", q(gaps));
console.log("satış rotası:", fmt(cnt(sells.map((r) => r.kind))));

H("H. Yeniden giriş: kapanıştan sonra aynı havuza dönüş");
const reentry = []; let reN = 0;
for (const c of closes) { const o = opens.find((x) => x.slot > c.slot && x.pool === c.pool); if (o) { reN++; reentry.push((o.t - c.t) / 60); } }
console.log("dönen", reN, "/", closes.length, "| bekleme dk q:", q(reentry));

H("J. Para hareketleri (transfer)");
const tr = rows.filter((r) => r.kind === "transfer" && !r.err);
for (const r of tr) console.log(new Date(r.t * 1000).toISOString().slice(0, 16), "SOL", SOL(r.solDelta).toFixed(3), "karşı:", (r.cps ?? []).slice(0, 3).map(([k, d]) => `${k.slice(0, 6)}(${SOL(d).toFixed(2)})`).join(" "));

H("Havuz evreni (girilen havuzlar)");
const used = [...new Set(opens.map((r) => r.pool))];
console.log("farklı havuz", used.length, "| bin_step:", fmt(cnt(used.map((p) => pools[p]?.binStep))), "| taban fee %:", fmt(cnt(used.map((p) => pools[p]?.baseFee))), "| Y:", fmt(cnt(used.map((p) => pools[p]?.y?.slice(0, 4)))));
console.log("havuz yaşı (açılış anında, saat) q:", q(opens.filter((r) => pools[r.pool]?.created).map((r) => (r.t * 1000 - pools[r.pool].created) / 3.6e6)));
console.log("launchpad:", fmt(cnt(used.map((p) => pools[p]?.launchpad))));
