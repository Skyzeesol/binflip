// Pre-registered hold-out test of the FINDINGS hypotheses. Everything that is fitted is fitted on
// the TRAIN period only; the HOLDOUT period is used once, to score.
//
//   node holdout.mjs [splitISO=2026-11-20T00:00:00Z]      (reads data/features.jsonl, data/pnl.jsonl)
//
// Registered before looking at the holdout (FINDINGS.md, 27–28 Nov):
//   H1 entry: opens follow a volume burst: share of opens with spike5 >= 0.9 is higher than for the
//      control point (same pool, 2 h earlier, no position); AUC(open vs control) on spike5 > 0.5.
//   H2 lot: calmer tokens get bigger lots: median range15 is ordered 7 SOL < 2 SOL < 1 SOL; cut
//      points (midpoints of TRAIN medians) predict the tier better than "always the most common".
//   H3 exit: a passive close (no move for >= 5 min) lands 50–65 min after the last move (the ~55 min
//      idle timeout) — share in TRAIN vs HOLDOUT.
import fs from "node:fs";

const DATA = process.env.DATA_DIR ?? "data";
const split = Date.parse(process.argv[2] ?? "2026-11-20T00:00:00Z") / 1000;
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const feats = lines(`${DATA}/features.jsonl`);
const pnl = lines(`${DATA}/pnl.jsonl`);
const period = (t) => (t < split ? "train" : "holdout");
const med = (a) => { const s = a.filter((x) => x != null && Number.isFinite(x)).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const auc = (pos, neg) => {
  const p = pos.filter(Number.isFinite), n = neg.filter(Number.isFinite);
  if (!p.length || !n.length) return null;
  let wins = 0;
  for (const a of p) for (const b of n) wins += a > b ? 1 : a === b ? 0.5 : 0;
  return +(wins / (p.length * n.length)).toFixed(3);
};
const out = { split: new Date(split * 1000).toISOString(), H1: {}, H2: {}, H3: {} };

// H1
for (const per of ["train", "holdout"]) {
  const o = feats.filter((e) => e.kind === "open" && period(e.t) === per && e.spike5 != null);
  const c = feats.filter((e) => e.kind === "control" && period(e.t) === per && e.spike5 != null);
  const share = (a) => (a.length ? +(a.filter((e) => e.spike5 >= 0.9).length / a.length).toFixed(3) : null);
  out.H1[per] = { opens: o.length, controls: c.length, openShareSpike09: share(o), controlShareSpike09: share(c), auc: auc(o.map((e) => e.spike5), c.map((e) => e.spike5)), unknownVolumeOpens: feats.filter((e) => e.kind === "open" && period(e.t) === per && e.spike5 == null).length };
}

// H2
const tier = (lot) => (Math.abs(lot - 1) < 0.05 ? "1" : Math.abs(lot - 2) < 0.05 ? "2" : Math.abs(lot - 7) < 0.05 ? "7" : null);
const opens = (per) => feats.filter((e) => e.kind === "open" && period(e.t) === per && tier(e.lotSol) && e.range15 != null);
const trainMed = Object.fromEntries(["1", "2", "7"].map((k) => [k, med(opens("train").filter((e) => tier(e.lotSol) === k).map((e) => e.range15))]));
const cut72 = trainMed["7"] != null && trainMed["2"] != null ? (trainMed["7"] + trainMed["2"]) / 2 : null;
const cut21 = trainMed["2"] != null && trainMed["1"] != null ? (trainMed["2"] + trainMed["1"]) / 2 : null;
const predict = (r) => (cut72 != null && r <= cut72 ? "7" : cut21 != null && r <= cut21 ? "2" : "1");
for (const per of ["train", "holdout"]) {
  const a = opens(per);
  const counts = a.reduce((m, e) => ((m[tier(e.lotSol)] = (m[tier(e.lotSol)] ?? 0) + 1), m), {});
  const majority = Object.entries(counts).sort((x, y) => y[1] - x[1])[0]?.[0];
  out.H2[per] = {
    n: a.length,
    medianRange15: Object.fromEntries(["1", "2", "7"].map((k) => [k, med(a.filter((e) => tier(e.lotSol) === k).map((e) => e.range15))])),
    ruleAccuracy: a.length ? +(a.filter((e) => predict(e.range15) === tier(e.lotSol)).length / a.length).toFixed(3) : null,
    baselineAccuracy: a.length && majority ? +(counts[majority] / a.length).toFixed(3) : null,
  };
}
out.H2.cutsFromTrain = { "7|2": cut72, "2|1": cut21 };

// H3 as an EXIT RULE: every moment a position sat 55 min without a move is a trigger. Matched = the
// leader closed within 55–65 min of the last move; kept open = the leader moved again or closed
// later than 65 min (the rule would have closed a position the leader kept). From rows.jsonl.
const rowsFile = `${DATA}/rows.jsonl`;
const rows = fs.existsSync(rowsFile) ? fs.readFileSync(rowsFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => !r.err && r.position) : [];
const evByPos = new Map();
for (const r of rows) {
  const ev = r.created ? "open" : r.closed ? "close" : r.newMin != null ? "move" : null;
  if (!ev) continue;
  const a = evByPos.get(r.position) ?? [];
  a.push([r.t, ev]);
  evByPos.set(r.position, a);
}
const rule = { train: { triggers: 0, matched: 0, keptOpen: 0, closesActive: 0 }, holdout: { triggers: 0, matched: 0, keptOpen: 0, closesActive: 0 } };
for (const evs of evByPos.values()) {
  evs.sort((a, b) => a[0] - b[0]);
  if (!evs.some((e) => e[1] === "close")) continue; // only positions we saw close
  for (let i = 1; i < evs.length; i++) {
    const gap = evs[i][0] - evs[i - 1][0];
    const per = period(evs[i - 1][0] + 55 * 60);
    if (gap >= 55 * 60) {
      rule[per].triggers++;
      if (evs[i][1] === "close" && gap <= 65 * 60) rule[per].matched++;
      else rule[per].keptOpen++;
    } else if (evs[i][1] === "close") rule[per].closesActive++; // closed before 55 min idle: another reason
  }
}
for (const per of ["train", "holdout"]) {
  const r = rule[per];
  out.H3[per + "Rule"] = { ...r, precision: r.triggers ? +(r.matched / r.triggers).toFixed(3) : null };
}
// H3 descriptive (by the position's open time t0, written by pnl.mjs)
for (const per of ["train", "holdout"]) {
  const passive = pnl.filter((c) => c.t0 !== undefined && period(c.t0) === per && c.minSinceMove >= 5);
  out.H3[per] = { passive: passive.length, share50to65: passive.length ? +(passive.filter((c) => c.minSinceMove >= 50 && c.minSinceMove <= 65).length / passive.length).toFixed(3) : null };
}
console.log(JSON.stringify(out, null, 1));
