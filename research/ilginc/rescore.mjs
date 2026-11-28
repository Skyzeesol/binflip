// Re-score a LIVE shadow window (mm-data: ours.*.jsonl = every decision we took, with the pool
// observation it came from; compare.*.jsonl / leader.*.jsonl = every leader move) with a given
// ShadowBook version, so the old and the fixed scoring can be compared on the same window.
//
//   node rescore.mjs <mm-data dir> <ShadowBook module> [leaderDelaySec=3] [fromISO] [toISO]
//
// Inputs replayed: our decision points as pool observations (only those: between them the book
// held, so its state is reproduced exactly), leader opens, rebalances and closes. The live service
// handled a leader tx some seconds after its block (polling); records do not keep that moment, so
// it is modelled as blockTime + leaderDelaySec (the result is reported for that assumption).
// missed / not_seen need every pool read, which the records do not keep: both are reported
// together as "no_decision" here.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [dir, modPath, delayArg, from, to] = process.argv.slice(2);
const delay = Number(delayArg ?? 3);
const lo = from ? Date.parse(from) / 1000 : -Infinity, hi = to ? Date.parse(to) / 1000 : Infinity;
const { ShadowBook } = await import(pathToFileURL(path.resolve(modPath)).href);
const read = (kind) => fs.readdirSync(dir).filter((f) => f.startsWith(kind + ".") && f.endsWith(".jsonl")).sort()
  .flatMap((f) => fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean));

const events = [];
for (const o of read("ours")) if (o.next && o.t >= lo && o.t < hi) events.push({ at: o.t, order: 1, kind: "tick", pool: o.pool, active: o.active, t: o.t, slot: o.slot ?? undefined });
const lastNext = new Map(); // position -> the leader's latest range (old range for records that lack it)
const leaderRows = [];
for (const l of read("leader")) if (l.t >= lo && l.t < hi) leaderRows.push({ at: l.t + delay, order: 0, ...l, src: "leader" });
for (const c of read("compare")) if (c.t >= lo && c.t < hi) leaderRows.push({ at: c.t + delay, order: 0, ...c, src: "compare" });
for (const e of leaderRows) events.push(e);
events.sort((a, b) => a.at - b.at || a.order - b.order);

const book = new ShadowBook();
const binStep = new Map();
for (const l of read("leader")) if (l.binStep) binStep.set(l.pool, l.binStep);
// positions opened before the window: bin step from the research pool list (POOLS_JSON or data/pools.json)
const poolsFile = process.env.POOLS_JSON ?? path.join(path.dirname(new URL(import.meta.url).pathname), "data", "pools.json");
if (fs.existsSync(poolsFile)) for (const [a, p] of Object.entries(JSON.parse(fs.readFileSync(poolsFile, "utf8")))) if (p.binStep && !binStep.has(a)) binStep.set(a, p.binStep);
const out = [];
for (const e of events) {
  if (e.kind === "tick") { book.onTick(e.pool, e.active, e.t, e.slot); continue; }
  if (e.src === "leader" && e.kind === "open") {
    if (!book.has(e.position) && (e.side === "sol" || e.side === "token")) book.onOpen({ position: e.position, pool: e.pool, binStep: e.binStep, range: { lower: e.lower, upper: e.lower + e.width - 1, side: e.side }, t: e.t, slot: undefined });
    lastNext.set(e.position, { lower: e.lower, upper: e.lower + e.width - 1 });
  } else if (e.src === "leader" && e.kind === "close") {
    book.onClose(e.position, e.t);
  } else if (e.src === "compare") {
    const bs = binStep.get(e.pool) ?? e.binStep;
    const old = e.leader.old ?? lastNext.get(e.position) ?? e.leader.next; // older records: the previous leader range
    if (!bs) continue;
    out.push(book.onLeaderRebalance({ position: e.position, pool: e.pool, binStep: bs, t: e.t, slot: e.leaderSlot, active: e.leader.active, old, next: e.leader.next }));
    lastNext.set(e.position, { lower: e.leader.next.lower, upper: e.leader.next.upper });
  }
}
const scored = out.filter((c) => c.outcome !== "adopted");
const n = (f) => scored.filter(f).length;
const pct = (k) => (scored.length ? +((k / scored.length) * 100).toFixed(1) : null);
console.log(JSON.stringify({
  dir, module: modPath, leaderDelaySec: delay, compared: scored.length,
  match: pct(n((c) => c.outcome === "match")), match_other_bin: pct(n((c) => c.outcome === "match_other_bin")), wrong_side: pct(n((c) => c.outcome === "wrong_side")),
  no_decision: pct(n((c) => c.outcome === "missed" || c.outcome === "not_seen" || c.outcome === "desync")),
  matchBeforeBySlot: pct(n((c) => c.outcome === "match" && c.timing === "before")),
  matchBeforeButDecidedLate: pct(n((c) => c.outcome === "match" && c.timing === "before" && c.decidedAfterLeaderBlock === true)),
  slotted: pct(n((c) => c.timing && c.timing !== "unknown")),
  extra: scored.reduce((s, c) => s + (c.extra ?? 0), 0),
}));
