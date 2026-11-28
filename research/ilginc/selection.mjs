// H4 pool selection, from the recorder: at each leader SOL open, the chosen pool vs every OTHER
// eligible pool in the SAME pre-decision universe snapshot (the newest snapshot taken before the
// open's block time, at most 5 min old). Eligible = SOL is Y and the bin step is one the leader
// uses. For each feature: the chosen pool's percentile among the eligible ones (0.5 = no signal,
// 1 = always the top). TRAIN / HOLDOUT split at a fixed time.
//
//   node selection.mjs <recorder dir> [splitISO]
import fs from "node:fs";
import path from "node:path";
import { gzLines } from "./gzlines.mjs";
import { decodeMeteoraTx } from "../../packages/core/dist/meteora/decode.js";
import { leaderEvents } from "../../apps/mm/dist/leaderEvents.js";

const [dir, splitArg] = process.argv.slice(2);
const LEADER = process.env.LEADER ?? "BviQcBvnWv5HHxHcouTwRFhrAMPNKuMLzEaSuxCuv6eU";
const WSOL = "So11111111111111111111111111111111111111112";
const MAX_AGE_MS = 5 * 60_000;
const shards = (kind) => fs.readdirSync(dir).filter((f) => f.startsWith(kind + ".") && f.endsWith(".jsonl.gz")).sort();

const opens = [];
for (const f of shards("tx")) for await (const line of gzLines(path.join(dir, f))) {
  let tx; try { tx = JSON.parse(line); } catch { continue; }
  if (tx.meta?.err || !tx.blockTime) continue;
  let dec = []; try { dec = decodeMeteoraTx(tx); } catch { continue; }
  for (const ev of leaderEvents(dec, LEADER)) if (ev.kind === "open" && ev.side === "sol") opens.push({ t: tx.blockTime * 1000, pool: ev.pool, lotSol: Number(ev.amountY) / 1e9 });
}
opens.sort((a, b) => a.t - b.t);
const snaps = [];
for (const f of shards("universe")) for await (const line of gzLines(path.join(dir, f))) { try { const j = JSON.parse(line); snaps.push({ t: j.t, pools: j.pools }); } catch {} }
snaps.sort((a, b) => a.t - b.t);
const split = splitArg ? Date.parse(splitArg) : opens.length ? opens[Math.floor(opens.length / 2)].t : 0;

const feats = {
  ftr30m: (p) => p.ftr?.["30m"], ftr1h: (p) => p.ftr?.["1h"], vol30m: (p) => p.v?.["30m"], vol1h: (p) => p.v?.["1h"], fees1h: (p) => p.f?.["1h"],
  tvl: (p) => p.tvl, mcap: (p) => p.mc, holders: (p) => p.h, dynFee: (p) => p.df, baseFee: (p) => p.bf, ageH: (p, t) => (p.c ? (t - p.c) / 3.6e6 : null),
};
const bsUsed = new Set();
const res = { train: [], holdout: [] };
let noSnap = 0, notInUniverse = 0;
let si = 0;
for (const o of opens) {
  while (si + 1 < snaps.length && snaps[si + 1].t <= o.t) si++;
  const s = snaps[si];
  if (!s || s.t > o.t || o.t - s.t > MAX_AGE_MS) { noSnap++; continue; }
  const chosen = s.pools.find((p) => p.a === o.pool);
  if (!chosen) { notInUniverse++; continue; }
  if (chosen.bs) bsUsed.add(chosen.bs);
  const eligible = s.pools.filter((p) => p.y === WSOL && p.a !== o.pool && (!bsUsed.size || bsUsed.has(p.bs)));
  const row = { t: o.t, eligible: eligible.length };
  for (const [k, f] of Object.entries(feats)) {
    const v = f(chosen, o.t);
    const others = eligible.map((p) => f(p, o.t)).filter((x) => x != null && Number.isFinite(x));
    row[k] = v == null || !others.length ? null : (others.filter((x) => x < v).length + 0.5 * others.filter((x) => x === v).length) / others.length;
  }
  res[o.t < split ? "train" : "holdout"].push(row);
}
const med = (a) => { const s = a.filter((x) => x != null).sort((x, y) => x - y); return s.length ? +s[Math.floor(s.length / 2)].toFixed(3) : null; };
const top = (a, q) => { const s = a.filter((x) => x != null); return s.length ? +(s.filter((x) => x >= q).length / s.length).toFixed(3) : null; };
const summary = { split: new Date(split).toISOString(), opens: opens.length, noRecentSnapshot: noSnap, chosenNotInUniverse: notInUniverse };
for (const per of ["train", "holdout"]) {
  summary[per] = { n: res[per].length, medianEligible: med(res[per].map((r) => r.eligible)) };
  for (const k of Object.keys(feats)) summary[per][k] = { medianPercentile: med(res[per].map((r) => r[k])), shareTop20: top(res[per].map((r) => r[k]), 0.8) };
}
console.log(JSON.stringify(summary, null, 1));
