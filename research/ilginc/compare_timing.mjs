// Timing breakdown of shadow comparisons (mm-data/compare.*.jsonl), with a stated method:
//  - records WITH slots (written by mm ≥ the slot-timing commit): by slot, exact
//    before / same_slot / after
//  - records WITHOUT slots (older): APPROXIMATE, by wall time vs the leader's block time (1 s
//    resolution): lagSec ≤ −2 → "likely_before", ≥ +2 → "likely_after", else "ambiguous".
// Optional window: node compare_timing.mjs <mm-data dir> [fromISO] [toISO]
import fs from "node:fs";
import path from "node:path";
const [dir, from, to] = process.argv.slice(2);
const lo = from ? Date.parse(from) / 1000 : -Infinity, hi = to ? Date.parse(to) / 1000 : Infinity;
const rows = [];
for (const f of fs.readdirSync(dir).filter((f) => f.startsWith("compare.")).sort())
  for (const l of fs.readFileSync(path.join(dir, f), "utf8").split("\n")) if (l) { const c = JSON.parse(l); if (c.t >= lo && c.t < hi) rows.push(c); }
const scored = rows.filter((c) => c.outcome !== "adopted");
const withSlot = scored.filter((c) => c.timing !== undefined && c.timing !== "unknown");
const timingOf = (c) => {
  if (c.timing && c.timing !== "unknown") return c.timing;
  if (!c.ours) return "no_decision";
  if (c.lagSec == null) return "ambiguous";
  return c.lagSec <= -2 ? "likely_before" : c.lagSec >= 2 ? "likely_after" : "ambiguous";
};
const t0 = scored.length ? new Date(Math.min(...scored.map((c) => c.t)) * 1000).toISOString().slice(0, 16) : "-";
const t1 = scored.length ? new Date(Math.max(...scored.map((c) => c.t)) * 1000).toISOString().slice(0, 16) : "-";
console.log(`${dir}  pencere ${t0} → ${t1}  karşılaştırma ${scored.length}  slotlu ${withSlot.length} (${scored.length ? ((withSlot.length / scored.length) * 100).toFixed(1) : 0}%)  ${withSlot.length === scored.length ? "yöntem: slot (kesin)" : withSlot.length ? "yöntem: karışık" : "yöntem: saat (yaklaşık)"}`);
const outcomes = ["match", "match_other_bin", "wrong_side", "missed", "not_seen"];
const timings = ["before", "same_slot", "after", "likely_before", "ambiguous", "likely_after", "no_decision"];
const m = new Map();
for (const c of scored) { const k = `${c.outcome}|${timingOf(c)}`; m.set(k, (m.get(k) ?? 0) + 1); }
const pct = (n) => (scored.length ? ((n / scored.length) * 100).toFixed(1) : "-");
console.log("sonuç".padEnd(16) + timings.map((t) => t.padStart(14)).join("") + "     toplam");
for (const o of outcomes) {
  const cells = timings.map((t) => m.get(`${o}|${t}`) ?? 0);
  const tot = cells.reduce((a, b) => a + b, 0);
  if (!tot) continue;
  console.log(o.padEnd(16) + cells.map((n) => (n ? `${n} (%${pct(n)})` : "·").padStart(14)).join("") + `     ${tot} (%${pct(tot)})`);
}
const n = (k) => m.get(k) ?? 0;
const matchAll = timings.reduce((a, t) => a + n(`match|${t}`), 0);
console.log(`\nbirebir (zamandan bağımsız):                 %${pct(matchAll)}  (${matchAll})`);
console.log(`birebir VE önce — slotla DOĞRULANMIŞ:         %${pct(n("match|before"))}  (${n("match|before")})   aynı slot %${pct(n("match|same_slot"))}  sonra %${pct(n("match|after"))}`);
console.log(`birebir VE muhtemelen önce — saat, YAKLAŞIK:  %${pct(n("match|likely_before"))}  (${n("match|likely_before")})   belirsiz %${pct(n("match|ambiguous"))}  muhtemelen sonra %${pct(n("match|likely_after"))}`);
console.log(`(iki oran toplanmaz: farklı yöntemler; slotlu kayıt payı %${scored.length ? ((withSlot.length / scored.length) * 100).toFixed(1) : 0})`);
