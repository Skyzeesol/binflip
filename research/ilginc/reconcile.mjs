// Reconcile the position PnL ESTIMATE (pnl.mjs: tokens marked at the active-bin price) with
// what actually happened in the wallet (lamports), at two levels:
//  1) wallet: Σ SOL change of every tx (incl. failed ones' fees) − external transfers
//  2) position: Σ SOL change of the position's own txs (open, rebalances, claims, close: rent,
//     tx fees, bin-array rent included) + SOL from selling that token after the close.
//     Only positions whose token sales can be attributed (no other position in the same token
//     overlapping the window) and whose tokens were fully sold count as "comparable".
// Usage: node reconcile.mjs   (reads data/rows.jsonl, data/pools.json, data/pnl.jsonl)
import fs from "node:fs";
const DATA = process.env.DATA_DIR ?? "data";
const rows = fs.readFileSync(`${DATA}/rows.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l)).sort((a, b) => a.slot - b.slot);
const pools = JSON.parse(fs.readFileSync(`${DATA}/pools.json`, "utf8"));
const est = new Map(fs.readFileSync(`${DATA}/pnl.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).map((c) => [c.position, c]));
const SOL = (l) => l / 1e9;
const isSale = (r) => /swap/.test(r.kind) && !r.err;
// Tokens left after the window: below 0.5% of what was received counts as dust (ignored, value ~0).
const unsoldBeyondDust = (left, received) => left > 0n && left * 200n > received;

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
for (const [position, seq] of byPos) {
  const open = seq.find((r) => r.created && !r.err), close = seq.find((r) => r.closed && !r.err);
  if (!open || !close) continue;
  windows.push({ position, pool: open.pool, mint: pools[open.pool]?.x, from: open.t, to: close.t, seq });
}
const sales = rows.filter(isSale);
const res = { comparable: [], overlapping: 0, unsold: 0, noEstimate: 0, noMint: 0 };
for (const w of windows) {
  if (!w.mint) { res.noMint++; continue; }
  const e = est.get(w.position);
  if (!e) { res.noEstimate++; continue; }
  const end = w.to + 3600;
  const overlap = windows.some((o) => o !== w && o.mint === w.mint && o.from <= end && o.to >= w.from);
  if (overlap) { res.overlapping++; continue; }
  const own = w.seq.reduce((s, r) => s + (r.solDelta ?? 0), 0); // includes failed txs' fees
  let tok = 0n, recv = 0n;
  for (const r of w.seq) if (!r.err) { const d = BigInt(r.tokDelta?.[w.mint] ?? 0); tok += d; if (d > 0n) recv += d; }
  let sold = 0;
  for (const r of sales) if (r.t >= w.from && r.t <= end && r.tokDelta?.[w.mint]) { sold += r.solDelta ?? 0; tok += BigInt(r.tokDelta[w.mint]); }
  if (unsoldBeyondDust(tok, recv)) { res.unsold++; continue; } // tokens still in the wallet: realized result incomplete
  res.comparable.push({ position: w.position, name: e.name, estSol: (e.pnlPct * e.lotSol) / 100, realSol: SOL(own + sold), feeSol: (e.feePct * e.lotSol) / 100, rebalances: e.rebalances });
}
const c = res.comparable;
const sum = (k) => c.reduce((s, x) => s + x[k], 0);
const q = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? [0.1, 0.25, 0.5, 0.75, 0.9].map((p) => s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(4)).join(" | ") : "-"; };
console.log(`\n## 2) Pozisyon seviyesi (dönem içinde açılıp kapanan ${windows.length} pozisyon)`);
console.log(`karşılaştırılabilir: ${c.length}   aynı token'da üst üste binen (satış ayrıştırılamaz): ${res.overlapping}   satılmamış token kalan: ${res.unsold}   tahmini yok (lotsuz/fiyatsız): ${res.noEstimate}`);
console.log(`Σ tahmin (pnl.mjs)        ${sum("estSol").toFixed(2)} SOL`);
console.log(`Σ gerçekleşen (cüzdan)    ${sum("realSol").toFixed(2)} SOL`);
console.log(`fark (gerçekleşen − tahmin) pozisyon başına SOL, q10 | q25 | medyan | q75 | q90:  ${q(c.map((x) => x.realSol - x.estSol))}`);
console.log(`fark / lot oranı yerine: Σ fark ${(sum("realSol") - sum("estSol")).toFixed(2)} SOL; farkın beklenen kaynakları: işlem ücretleri, bin array kirası (geri dönmez), token satış kayması/fiyat farkı`);
const per = (k) => (c.length ? (sum(k) / c.length).toFixed(4) : "-");
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
const ch = { comparable: [], unsold: 0, noEstimate: 0 };
for (const k of chains) {
  if (k.items.some((w) => !est.has(w.position))) { ch.noEstimate++; continue; }
  const end = k.to + 3600;
  let realL = 0, tok = 0n, recv = 0n;
  for (const w of k.items) for (const r of w.seq) { realL += r.solDelta ?? 0; if (!r.err) { const d = BigInt(r.tokDelta?.[k.mint] ?? 0); tok += d; if (d > 0n) recv += d; } }
  for (const r of sales) if (r.t >= k.from && r.t <= end && r.tokDelta?.[k.mint]) { realL += r.solDelta ?? 0; tok += BigInt(r.tokDelta[k.mint]); }
  if (unsoldBeyondDust(tok, recv)) { ch.unsold++; continue; }
  const estSol = k.items.reduce((s, w) => { const e = est.get(w.position); return s + (e.pnlPct * e.lotSol) / 100; }, 0);
  ch.comparable.push({ positions: k.items.length, estSol, realSol: SOL(realL) });
}
const cc = ch.comparable, cpos = cc.reduce((s, x) => s + x.positions, 0);
const csum = (k) => cc.reduce((s, x) => s + x[k], 0);
console.log(`zincir: ${chains.length}   karşılaştırılabilir: ${cc.length} (${cpos} pozisyon = %${((cpos / windows.length) * 100).toFixed(1)})   satılmamış token kalan: ${ch.unsold}   tahmini eksik: ${ch.noEstimate}`);
console.log(`Σ tahmin ${csum("estSol").toFixed(2)} SOL · Σ gerçekleşen ${csum("realSol").toFixed(2)} SOL · fark ${(csum("realSol") - csum("estSol")).toFixed(2)} SOL (pozisyon başına ${cpos ? ((csum("realSol") - csum("estSol")) / cpos).toFixed(4) : "-"} SOL)`);
