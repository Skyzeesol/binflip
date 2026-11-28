// Reconcile the position PnL ESTIMATE (pnl.mjs: tokens marked at the active-bin price) with
// what actually happened in the wallet (lamports), at two levels:
//  1) wallet: Σ SOL change of every tx (incl. failed ones' fees) − external transfers
//  2) position: Σ SOL change of the position's own txs (open, rebalances, claims, close: rent,
//     tx fees, bin-array rent included) + SOL from selling that token after the close.
//     Only positions whose token sales can be attributed (no other position in the same token
//     overlapping the window) and whose tokens were fully sold count as "comparable".
// Usage: node reconcile.mjs   (reads data/rows.jsonl, data/pools.json, data/pnl.jsonl)
import fs from "node:fs";
import { attribute } from "./attrib.mjs";
const DATA = process.env.DATA_DIR ?? "data";
const rows = fs.readFileSync(`${DATA}/rows.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l)).sort((a, b) => a.slot - b.slot);
const pools = JSON.parse(fs.readFileSync(`${DATA}/pools.json`, "utf8"));
const est = new Map(fs.readFileSync(`${DATA}/pnl.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).map((c) => [c.position, c]));
const SOL = (l) => l / 1e9;
// A sale is a swap row that is NOT a position's own row (a rebalance+swap signature belongs to
// the position and is counted there, once). Wallet deltas are on walletRow rows only (extract).
const isSale = (r) => /swap/.test(r.kind) && !r.err && !r.position && r.walletRow !== false;
const sales = rows.filter(isSale);
const attributedSales = new Set(); // sale signatures used by a comparable position / chain
// Sale attribution (buys and sells not netted; dust < 0.5%; mixed sales): see attrib.mjs.
const swapsIn = (mint, from, to) => sales.filter((r) => r.t >= from && r.t <= to && r.tokDelta?.[mint]).map((r) => ({ ...r, tok: BigInt(r.tokDelta[mint]) }));

// 1) wallet level ─────────────────────────────────────────────────────────────
const total = rows.reduce((s, r) => s + (r.solDelta ?? 0), 0);
const transfers = rows.filter((r) => r.kind === "transfer" && !r.err && Math.abs(r.solDelta ?? 0) > 1e6);
const external = transfers.reduce((s, r) => s + r.solDelta, 0);
const fees = rows.reduce((s, r) => s + (r.fee ?? 0), 0);
const failedFees = rows.filter((r) => r.err).reduce((s, r) => s + (r.fee ?? 0), 0);
const tokensLeft = new Map();
for (const r of rows) if (!r.err) for (const [m, d] of Object.entries(r.tokDelta ?? {})) tokensLeft.set(m, (tokensLeft.get(m) ?? 0n) + BigInt(d));
const first = rows[0], last = rows.at(-1);
console.log(`## 1) Cüzdan seviyesi  (${new Date(first.t * 1000).toISOString().slice(0, 16)} → ${new Date(last.t * 1000).toISOString().slice(0, 16)}, ${rows.length} işlem)`);
console.log(`cüzdanın SOL değişimi (tüm işlemler)        ${SOL(total).toFixed(2)} SOL`);
console.log(`dış transferler (kasa vb., ${transfers.length} adet)        ${SOL(external).toFixed(2)} SOL`);
console.log(`→ işlemlerden gerçekleşen sonuç              ${SOL(total - external).toFixed(2)} SOL`);
console.log(`   içinde: işlem ücretleri ${SOL(fees).toFixed(3)} SOL (başarısızlar ${SOL(failedFees).toFixed(3)})`);
console.log(`dönem sonunda satılmamış token çeşidi: ${[...tokensLeft].filter(([, v]) => v > 0n).length}  (değerleri bu sonuca dahil DEĞİL)`);
console.log(`not: dönem başında/sonunda açık pozisyonlar bu sonucu iki yönde de etkiler (başlangıçtakilerin kapanışı gelir gibi, sondakilerin açılışı gider gibi görünür).`);

// 2) position level ───────────────────────────────────────────────────────────
const byPos = new Map();
for (const r of rows) if (r.position) { const a = byPos.get(r.position) ?? []; a.push(r); byPos.set(r.position, a); }
const windows = []; // per closed position: mint, [open, close]
const openAtEnd = []; // positions still open when the data ends: their token sales cannot be told apart
for (const [position, seq] of byPos) {
  const open = seq.find((r) => r.created && !r.err), close = seq.find((r) => r.closed && !r.err);
  const pool = (open ?? seq[0]).pool;
  if (!seq.some((r) => !r.err)) continue; // only failed txs (e.g. a failed open): the position never existed
  if (!close) { openAtEnd.push({ position, pool, mint: pools[pool]?.x, from: (open ?? seq[0]).t, to: Infinity }); continue; }
  if (!open) continue;
  // a signature that also moved another position: its wallet change cannot be split
  const shared = seq.some((r) => (r.positionsInTx ?? 1) > 1);
  windows.push({ position, pool: open.pool, mint: pools[open.pool]?.x, from: open.t, to: close.t, seq, shared });
}
const res = { comparable: [], overlapping: 0, unsold: 0, mixed: 0, externalBuy: 0, noEstimate: 0, noMint: 0, shared: 0 };
for (const w of windows) {
  if (!w.mint) { res.noMint++; continue; }
  const e = est.get(w.position);
  if (!e) { res.noEstimate++; continue; }
  const end = w.to + 3600;
  const overlap = [...windows, ...openAtEnd].some((o) => o !== w && o.mint === w.mint && o.from <= end && o.to >= w.from);
  if (overlap) { res.overlapping++; continue; }
  if (w.shared) { res.shared++; continue; }
  const own = w.seq.reduce((s, r) => s + (r.solDelta ?? 0), 0); // includes failed txs' fees
  let tok = 0n, recv = 0n;
  for (const r of w.seq) if (!r.err) { const d = BigInt(r.tokDelta?.[w.mint] ?? 0); tok += d; if (d > 0n) recv += d; }
  const sw = swapsIn(w.mint, w.from, end);
  const a = attribute(recv, tok, sw);
  if (a.status === "unsold") { res.unsold++; continue; } // tokens still in the wallet: realized result incomplete
  if (a.status === "mixed") { res.mixed++; continue; }
  if (a.status === "external_buy") { res.externalBuy++; continue; }
  const sold = a.soldLamports, soldTok = a.soldTok;
  const saleSigs = sw.filter((r) => r.tok < 0n).map((r) => `${r.kind}:${r.sig.slice(0, 8)}:${SOL(r.solDelta ?? 0).toFixed(3)}`);
  for (const r of sw) attributedSales.add(r.sig);
  res.comparable.push({ position: w.position, name: e.name, lotSol: e.lotSol, estSol: e.pnlSol ?? (e.pnlPct * e.lotSol) / 100, realSol: SOL(own + sold), ownSol: SOL(own), soldSol: SOL(sold), recvTok: recv.toString(), soldTok: soldTok.toString(), saleSigs, txs: w.seq.length, feeSol: e.feeSol ?? (e.feePct * e.lotSol) / 100, rebalances: e.rebalances });
}
const c = res.comparable;
const sum = (k) => c.reduce((s, x) => s + x[k], 0);
const q = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? [0.1, 0.25, 0.5, 0.75, 0.9].map((p) => s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(4)).join(" | ") : "-"; };
console.log(`\n## 2) Pozisyon seviyesi (dönem içinde açılıp kapanan ${windows.length} pozisyon)`);
console.log(`karşılaştırılabilir: ${c.length}   aynı token'da üst üste binen (satış ayrıştırılamaz): ${res.overlapping}   satılmamış token kalan: ${res.unsold}   karışık satış (başka pozisyonların token'ı da satılmış): ${res.mixed}   aynı token'da ayrıca alım (netlenmez): ${res.externalBuy}   başka pozisyonla ortak imza (bölünemez): ${res.shared}   dönem sonunda açık pozisyon: ${openAtEnd.length}   tahmini yok (lotsuz/fiyatsız): ${res.noEstimate}`);
console.log(`Σ tahmin (pnl.mjs)        ${sum("estSol").toFixed(2)} SOL`);
console.log(`Σ gerçekleşen (cüzdan)    ${sum("realSol").toFixed(2)} SOL`);
console.log(`fark (gerçekleşen − tahmin) pozisyon başına SOL, q10 | q25 | medyan | q75 | q90:  ${q(c.map((x) => x.realSol - x.estSol))}`);
console.log(`fark / lot oranı yerine: Σ fark ${(sum("realSol") - sum("estSol")).toFixed(2)} SOL; farkın beklenen kaynakları: işlem ücretleri, bin array kirası (geri dönmez), token satış kayması/fiyat farkı`);
const per = (k) => (c.length ? (sum(k) / c.length).toFixed(4) : "-");
if (process.argv.includes("--top")) {
  const byDiff = [...c].sort((a, b) => (b.realSol - b.estSol) - (a.realSol - a.estSol));
  const show = (x) => console.log(`  ${x.position.slice(0, 8)} ${String(x.name).padEnd(14)} lot ${x.lotSol} · tahmin ${x.estSol.toFixed(3)} · gerçek ${x.realSol.toFixed(3)} (kendi ${x.ownSol.toFixed(3)} + satış ${x.soldSol.toFixed(3)}) · token alınan ${x.recvTok} satılan ${x.soldTok} · tx ${x.txs} · satışlar ${x.saleSigs.slice(0, 4).join(" ")}${x.saleSigs.length > 4 ? ` +${x.saleSigs.length - 4}` : ""}`);
  console.log("en büyük POZİTİF fark (gerçekleşen ≫ tahmin):"); byDiff.slice(0, 8).forEach(show);
  console.log("en büyük NEGATİF fark:"); byDiff.slice(-5).forEach(show);
  const tot = sum("realSol") - sum("estSol"), top = byDiff.slice(0, 10).reduce((s, x) => s + x.realSol - x.estSol, 0);
  console.log(`ilk 10 pozitif uç farkın toplam farka katkısı: ${top.toFixed(2)} / ${tot.toFixed(2)} SOL`);
}
console.log(`pozisyon başına ortalama: tahmin ${per("estSol")} · gerçekleşen ${per("realSol")} · fee ${per("feeSol")} SOL`);

// 3) chain level: consecutive positions in the same token (re-entries within 1 h) as one unit,
//    so their token sales need no splitting. Covers most of what step 2 had to skip.
console.log(`\n## 3) Zincir seviyesi (aynı token'da 1 saat içinde birbirini izleyen pozisyonlar tek birim)`);
const byMint = new Map();
for (const w of windows) if (w.mint) { const a = byMint.get(w.mint) ?? []; a.push(w); byMint.set(w.mint, a); }
const chains = [];
for (const ws of byMint.values()) {
  ws.sort((a, b) => a.from - b.from);
  let cur = null;
  for (const w of ws) {
    if (cur && w.from <= cur.to + 3600) { cur.items.push(w); cur.to = Math.max(cur.to, w.to); }
    else { cur = { mint: w.mint, from: w.from, to: w.to, items: [w] }; chains.push(cur); }
  }
}
const ch = { comparable: [], unsold: 0, mixed: 0, externalBuy: 0, noEstimate: 0, openOverlap: 0, sharedOut: 0 };
const chainOf = new Map(); // position -> chain
for (const k of chains) for (const w of k.items) chainOf.set(w.position, k);
for (const k of chains) {
  if (k.items.some((w) => !est.has(w.position))) { ch.noEstimate++; continue; }
  const end = k.to + 3600;
  if (openAtEnd.some((o) => o.mint === k.mint && o.from <= end)) { ch.openOverlap++; continue; } // a still-open position of the same token
  // a shared signature is fine only if every position it moved is in this chain
  const sharedSigs = new Set(k.items.flatMap((w) => w.seq.filter((r) => (r.positionsInTx ?? 1) > 1).map((r) => r.sig)));
  if ([...sharedSigs].some((sig) => rows.some((r) => r.sig === sig && r.position && chainOf.get(r.position) !== k))) { ch.sharedOut++; continue; }
  let realL = 0, tok = 0n, recv = 0n;
  for (const w of k.items) for (const r of w.seq) { realL += r.solDelta ?? 0; if (!r.err) { const d = BigInt(r.tokDelta?.[k.mint] ?? 0); tok += d; if (d > 0n) recv += d; } }
  const chainSales = swapsIn(k.mint, k.from, end);
  const a = attribute(recv, tok, chainSales);
  if (a.status === "unsold") { ch.unsold++; continue; }
  if (a.status === "mixed") { ch.mixed++; continue; }
  if (a.status === "external_buy") { ch.externalBuy++; continue; }
  realL += a.soldLamports;
  for (const r of chainSales) attributedSales.add(r.sig);
  const estSol = k.items.reduce((s, w) => { const e = est.get(w.position); return s + (e.pnlSol ?? (e.pnlPct * e.lotSol) / 100); }, 0);
  ch.comparable.push({ positions: k.items.length, estSol, realSol: SOL(realL) });
}
const cc = ch.comparable, cpos = cc.reduce((s, x) => s + x.positions, 0);
const csum = (k) => cc.reduce((s, x) => s + x[k], 0);
console.log(`zincir: ${chains.length}   karşılaştırılabilir: ${cc.length} (${cpos} pozisyon = %${((cpos / windows.length) * 100).toFixed(1)})   satılmamış token kalan: ${ch.unsold}   karışık satış: ${ch.mixed}   ayrıca alım: ${ch.externalBuy}   açık pozisyonla aynı token: ${ch.openOverlap}   başka zincirle ortak imza: ${ch.sharedOut}   tahmini eksik: ${ch.noEstimate}`);
console.log(`Σ tahmin ${csum("estSol").toFixed(2)} SOL · Σ gerçekleşen ${csum("realSol").toFixed(2)} SOL · fark ${(csum("realSol") - csum("estSol")).toFixed(2)} SOL (pozisyon başına ${cpos ? ((csum("realSol") - csum("estSol")) / cpos).toFixed(4) : "-"} SOL)`);
const unattributed = sales.filter((r) => !attributedSales.has(r.sig));
console.log(`\nhiçbir karşılaştırılabilir pozisyona/zincire atfedilemeyen satış: ${unattributed.length} / ${sales.length} imza, ${SOL(unattributed.reduce((s, r) => s + (r.solDelta ?? 0), 0)).toFixed(2)} SOL (sonuçlara KATILMADI)`);

