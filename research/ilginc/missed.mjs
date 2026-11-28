// Diagnose shadow "missed" comparisons (mm-data/compare.*.jsonl).
//
// By construction a read that shows the leader's trigger (≥2 bins from the leader's OLD range)
// would have produced our own decision in the same onTick, IF our tracked range equalled the
// leader's old range. So every "missed" should be a range desync. For each one this script
// re-reads the leader's rebalance tx (by sig) for the real old range, reconstructs the range
// our book held (last sync = previous compare for that position, else the leader open record),
// and lists the leader's DLMM instructions on that position in between (via the position's
// signature history), so the cause of the desync is visible.
//
// Usage: RPC_URL=... node missed.mjs <mm-data dir>      (read-only RPC calls)
import fs from "node:fs";
import path from "node:path";
import { rpc } from "./rpc.mjs";
import { decodeMeteoraTx } from "../../packages/core/dist/meteora/decode.js";

const dir = process.argv[2] ?? "mm-data";
const read = (prefix) =>
  fs.readdirSync(dir).filter((f) => f.startsWith(prefix + ".")).sort()
    .flatMap((f) => fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
// leader slot order (several leader moves can share one block second)
const compares = read("compare").sort((a, b) => (a.leaderSlot ?? 0) - (b.leaderSlot ?? 0) || a.t - b.t);
const opens = read("leader").filter((l) => l.kind === "open");
const str = (v) => (v && typeof v.toBase58 === "function" ? v.toBase58() : String(v));
const getTx = (sig) => rpc("getTransaction", [sig, { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed" }]);

const OUTCOME = process.env.OUTCOME ?? "missed"; // OUTCOME=match: exercise the script on a control group
const missed = compares.filter((c) => c.outcome === OUTCOME);
console.log(`${dir}: ${compares.length} comparisons, ${missed.length} ${OUTCOME}${OUTCOME === "missed" ? "" : " (control group: 'cause' labels only mean something for missed)"}`);
const causes = {};
for (const m of missed) {
  const prev = compares.slice(0, compares.indexOf(m)).filter((c) => c.position === m.position).at(-1);
  const open = opens.find((o) => o.position === m.position);
  const ours = prev ? { lower: prev.leader.next.lower, upper: prev.leader.next.upper, from: `compare ${prev.outcome} ${prev.sig?.slice(0, 8)}` }
    : open ? { lower: open.lower, upper: open.lower + open.width - 1, from: `open ${open.sig.slice(0, 8)}` } : null;
  const tx = await getTx(m.sig);
  const ev = decodeMeteoraTx(tx).find((d) => d.kind === "event" && d.name === "Rebalancing" && str(d.data.position) === m.position);
  const old = ev ? { lower: Number(ev.data.old_min_id), upper: Number(ev.data.old_max_id) } : null;
  // leader txs on this position between our sync point and the missed event
  const fromSlot = prev?.leaderSlot ?? 0;
  const sigs = (await rpc("getSignaturesForAddress", [m.position, { before: m.sig, limit: 15 }])) ?? [];
  const between = [];
  for (const s of sigs) {
    if (s.signature === prev?.sig || s.slot <= fromSlot) break; // reached our sync point
    const t2 = await getTx(s.signature);
    const names = t2 ? decodeMeteoraTx(t2).filter((d) => d.protocol === "dlmm").map((d) => d.name) : ["?"];
    between.push(`${s.signature.slice(0, 8)}${s.err ? "(FAILED)" : ""}:${[...new Set(names)].join("+")}`);
  }
  const desync = ours && old ? ours.lower !== old.lower || ours.upper !== old.upper : null;
  const cause = !ours ? "no_sync_point" : !old ? "no_event" : !desync ? "SAME_RANGE (rule/engine bug)" : between.some((b) => !b.includes("FAILED")) ? "leader_changed_range_unseen" : "desync_other";
  causes[cause] = (causes[cause] ?? 0) + 1;
  console.log(`\n${new Date(m.t * 1000).toISOString().slice(11, 19)} ${m.position.slice(0, 8)} pool ${m.pool.slice(0, 8)} sig ${m.sig?.slice(0, 8)} slot ${m.leaderSlot}`);
  console.log(`  leader: active ${m.leader.active} old [${old?.lower}, ${old?.upper}] → next [${m.leader.next.lower}, ${m.leader.next.upper}] ${m.leader.next.side}`);
  console.log(`  ours:   [${ours?.lower}, ${ours?.upper}] (from ${ours?.from})  desync=${desync}  → ${cause}`);
  console.log(`  leader txs on the position in between (newest first): ${between.join("  ") || "-"}`);
}
console.log(`\ncauses: ${JSON.stringify(causes)}`);
