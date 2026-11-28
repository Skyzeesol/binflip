// Replay the shadow book over the recorder's archive (pool snapshots with slots + the leader's
// txs), so two scoring versions can be compared on IDENTICAL inputs.
//
//   node shadow_replay.mjs <recorder dir> <ShadowBook module> [fromISO] [toISO]
//     <ShadowBook module>: e.g. ../../packages/core/dist/mm/shadow.js (current) or a build of the
//     2a46516 version (see report steps). Prints the summary + a timing table as JSON.
//
// Order of events = wall time as the recorder saw them: a pool snapshot at its `t` (ms), a leader
// tx at its `recvMs` (when the recorder received it, i.e. polled, like the live service). Leader
// opens/rebalances/closes are taken with the same strict matching as the service (leaderEvents).
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gzLines } from "./gzlines.mjs";
import { decodeMeteoraTx } from "../../packages/core/dist/meteora/decode.js";
import { leaderEvents } from "../../apps/mm/dist/leaderEvents.js";

const [dir, modPath, from, to] = process.argv.slice(2);
const LEADER = process.env.LEADER ?? "BviQcBvnWv5HHxHcouTwRFhrAMPNKuMLzEaSuxCuv6eU";
const lo = from ? Date.parse(from) : -Infinity, hi = to ? Date.parse(to) : Infinity;
const { ShadowBook } = await import(pathToFileURL(path.resolve(modPath)).href);
const book = new ShadowBook();

const shards = (kind) => fs.readdirSync(dir).filter((f) => f.startsWith(kind + ".") && f.endsWith(".jsonl.gz")).sort();
const inHour = (f) => { const h = f.split(".")[1]; const t = Date.parse(`${h.slice(0, 4)}-${h.slice(4, 6)}-${h.slice(6, 8)}T${h.slice(8, 10)}:00:00Z`); return t + 3600_000 > lo && t < hi + 3600_000; };

// Leader events, by receive time.
const leader = [];
const binStep = new Map();
for (const f of shards("tx").filter(inHour)) {
  for await (const line of gzLines(path.join(dir, f))) {
    let tx; try { tx = JSON.parse(line); } catch { continue; }
    if (tx.meta?.err || (tx.wallet && tx.wallet !== LEADER)) continue;
    const at = tx.recvMs ?? (tx.blockTime ?? 0) * 1000;
    if (at < lo || at >= hi) continue;
    let decoded = []; try { decoded = decodeMeteoraTx(tx); } catch { continue; }
    for (const ev of leaderEvents(decoded, LEADER)) leader.push({ at, t: tx.blockTime, slot: tx.slot, ev });
  }
}
leader.sort((a, b) => a.at - b.at);
// bin steps from the universe snapshots (pool snapshots carry only the active bin)
for (const f of shards("universe")) {
  for await (const line of gzLines(path.join(dir, f))) {
    try { for (const p of JSON.parse(line).pools) if (p.bs) binStep.set(p.a, p.bs); } catch {}
  }
}

let li = 0, comparisons = [], exits = [], noBinStep = 0;
const flushLeader = (until) => {
  for (; li < leader.length && leader[li].at <= until; li++) {
    const { t, slot, ev } = leader[li];
    const bs = binStep.get(ev.pool ?? "") ?? null;
    if (ev.kind === "rebalance") {
      if (!bs) { noBinStep++; continue; }
      comparisons.push(book.onLeaderRebalance({ position: ev.position, pool: ev.pool, binStep: bs, t, slot, active: ev.active, old: ev.old, next: ev.next }));
    } else if (ev.kind === "close") {
      const r = book.onClose(ev.position, t);
      if (r) exits.push(r.exit);
    } else if (ev.kind === "open" && (ev.side === "sol" || ev.side === "token") && bs && !book.has(ev.position)) {
      book.onOpen({ position: ev.position, pool: ev.pool, binStep: bs, range: { lower: ev.lower, upper: ev.lower + ev.width - 1, side: ev.side }, t, slot });
    }
  }
};
for (const f of shards("pool").filter(inHour)) {
  for await (const line of gzLines(path.join(dir, f))) {
    let s; try { s = JSON.parse(line); } catch { continue; }
    if (s.t < lo || s.t >= hi) continue;
    flushLeader(s.t);
    const tSec = Math.floor(s.t / 1000);
    for (const [pool, v] of Object.entries(s.pools ?? {})) book.onTick(pool, v[0], tSec, s.slot ?? undefined);
    book.checkExits(tSec);
  }
}
flushLeader(Infinity);

const scored = comparisons.filter((c) => c.outcome !== "adopted");
const count = (f) => scored.filter(f).length;
const pct = (n) => (scored.length ? +((n / scored.length) * 100).toFixed(1) : null);
const out = {
  window: { from: from ?? null, to: to ?? null },
  module: modPath,
  compared: scored.length,
  adopted: comparisons.length - scored.length,
  leaderRebalancesWithoutBinStep: noBinStep,
  outcomes: Object.fromEntries(["match", "match_other_bin", "wrong_side", "missed", "desync", "not_seen"].map((o) => [o, count((c) => c.outcome === o)])),
  matchPct: pct(count((c) => c.outcome === "match")),
  matchBeforeBySlotPct: pct(count((c) => c.outcome === "match" && c.timing === "before")),
  matchSameSlotPct: pct(count((c) => c.outcome === "match" && c.timing === "same_slot")),
  matchAfterPct: pct(count((c) => c.outcome === "match" && c.timing === "after")),
  matchBeforeButDecidedLatePct: pct(count((c) => c.outcome === "match" && c.timing === "before" && c.decidedAfterLeaderBlock === true)),
  extra: scored.reduce((s, c) => s + (c.extra ?? 0), 0),
  exits: Object.fromEntries(["exit_match", "exit_early", "exit_late", "exit_other"].map((o) => [o, exits.filter((e) => e.outcome === o).length])),
};
console.log(JSON.stringify(out, null, 1));
