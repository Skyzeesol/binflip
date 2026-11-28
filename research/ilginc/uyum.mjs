// Shadow match rate with and without the cases where the LEADER, not our rules, caused the gap:
//  (a) leader_failed: between our decision and the leader's move, the leader sent rebalances that failed
//  (b) leader_waited: we moved, the leader waited > 60 s without even trying
// Usage: node uyum.mjs <live dir> <mm-data dir>
import fs from "node:fs";
import path from "node:path";
import { gzLines } from "./gzlines.mjs";
import { decodeMeteoraTx } from "../../packages/core/dist/meteora/decode.js";

const [liveDir, mmDir] = process.argv.slice(2);
const cmp = [];
for (const f of fs.readdirSync(mmDir).filter((f) => f.startsWith("compare."))) for (const l of fs.readFileSync(path.join(mmDir, f), "utf8").split("\n")) if (l) cmp.push(JSON.parse(l));
const scored = cmp.filter((c) => c.outcome !== "adopted");
const positions = new Set(scored.map((c) => c.position));

const attempts = new Map(); // position -> [{t, ok}]
for (const f of fs.readdirSync(liveDir).filter((f) => f.startsWith("tx.") && f.endsWith(".gz")).sort()) {
  for await (const line of gzLines(path.join(liveDir, f))) {
    let tx; try { tx = JSON.parse(line); } catch { continue; }
    let d; try { d = decodeMeteoraTx(tx); } catch { continue; }
    const rb = d.find((x) => x.kind === "ix" && x.name === "rebalance_liquidity");
    if (!rb || !positions.has(rb.accounts.position)) continue;
    const a = attempts.get(rb.accounts.position) ?? []; a.push({ t: tx.blockTime, ok: !tx.meta.err }); attempts.set(rb.accounts.position, a);
  }
}

for (const c of scored) {
  const from = c.ours?.t, to = c.t;
  c.leaderFailed = from != null && from < to && (attempts.get(c.position) ?? []).some((a) => !a.ok && a.t >= from - 2 && a.t < to);
  c.leaderWaited = !c.leaderFailed && from != null && to - from > 60;
}
const BAD_POOLS = ["BfREfu", "BFKBQT"];
const rate = (set, label) => {
  const n = set.length, k = (o) => set.filter((c) => c.outcome === o).length;
  const pct = (x) => (n ? ((x / n) * 100).toFixed(1) : "-");
  console.log(label.padEnd(46), `n=${String(n).padEnd(5)} birebir %${pct(k("match"))}  doğru taraf %${pct(k("match") + k("match_other_bin"))}  yanlış taraf %${pct(k("wrong_side"))}  kural farkı %${pct(k("missed"))}  görmeden %${pct(k("not_seen"))}`);
};
console.log(`işaretlenen: lider başarısız deneme ${scored.filter((c) => c.leaderFailed).length}, lider denemeden bekledi ${scored.filter((c) => c.leaderWaited).length}\n`);
rate(scored, "hepsi");
rate(scored.filter((c) => !c.leaderFailed), "(a) liderin başarısız denemeleri hariç");
rate(scored.filter((c) => !c.leaderFailed && !c.leaderWaited), "(a)+(b) denemeden bekledikleri de hariç");
rate(scored.filter((c) => !BAD_POOLS.some((p) => c.pool.startsWith(p))), "iki sorunlu havuz hariç");
console.log("\nişaretlenen vakaların sonucu:");
for (const [lab, f] of [["lider başarısız", (c) => c.leaderFailed], ["lider bekledi", (c) => c.leaderWaited]]) {
  const m = new Map(); for (const c of scored.filter(f)) m.set(c.outcome, (m.get(c.outcome) ?? 0) + 1);
  console.log(" ", lab.padEnd(16), [...m].map(([k, v]) => `${k}:${v}`).join("  "));
}
