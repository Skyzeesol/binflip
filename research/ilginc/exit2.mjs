// "Active" exits (close < 5 min after a rebalance): what was different right before the close?
// Compared against the same positions' earlier rebalances (which were not followed by a close).
import fs from "node:fs";
const rows = fs.readFileSync("data/rows.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => !r.err && r.position).sort((a, b) => a.slot - b.slot);
const byPos = new Map(); for (const r of rows) { const a = byPos.get(r.position) ?? []; a.push(r); byPos.set(r.position, a); }
const q = (a) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? [0.1, 0.25, 0.5, 0.75, 0.9].map((p) => s[Math.min(s.length - 1, Math.floor(p * s.length))]).join(" | ") : "-"; };
const atClose = { dist: [], n5: [], n15: [], drift: [], gap: [] }, before = { dist: [], n5: [], n15: [], drift: [], gap: [] };
for (const seq of byPos.values()) {
  const open = seq.find((r) => r.created), close = seq.find((r) => r.closed);
  if (!open || !close) continue;
  const rbs = seq.filter((r) => r.kind === "rebalance_liquidity" && r.newMin != null);
  if (!rbs.length || close.t - rbs.at(-1).t >= 300) continue; // only "active" exits
  const entry = open.active;
  const feat = (i) => {
    const r = rbs[i]; const t = r.t;
    const d = r.active > r.oldMax ? r.active - r.oldMax : r.oldMin - r.active;
    return { dist: d, n5: rbs.filter((x) => x.t > t - 300 && x.t <= t).length, n15: rbs.filter((x) => x.t > t - 900 && x.t <= t).length, drift: Math.abs(r.active - entry), gap: i ? t - rbs[i - 1].t : null };
  };
  const last = feat(rbs.length - 1);
  for (const k in atClose) atClose[k].push(last[k]);
  for (let i = 0; i < rbs.length - 1; i++) { const f = feat(i); for (const k in before) before[k].push(f[k]); }
}
console.log(`aktif çıkış: ${atClose.dist.length} pozisyon   (q10 | q25 | medyan | q75 | q90)`);
const lab = { dist: "son taşımada sıçrama (bin)", n5: "son 5 dk taşıma sayısı", n15: "son 15 dk taşıma sayısı", drift: "girişten beri kayma (bin)", gap: "önceki taşımadan sn" };
for (const k in lab) console.log(lab[k].padEnd(30), "kapanış öncesi:", q(atClose[k]).padEnd(28), " diğer taşımalar:", q(before[k]));
