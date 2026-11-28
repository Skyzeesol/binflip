// When the shadow engine moved but the leader waited (wrong_side / missed / long negative lag),
// did the leader TRY and fail (rejected rebalances in that window), or not try at all?
// Usage: node waits.mjs <live dir> <mm-data dir>
import fs from "node:fs";
import path from "node:path";
import { gzLines } from "./gzlines.mjs";
import { decodeMeteoraTx } from "../../packages/core/dist/meteora/decode.js";

const [liveDir, mmDir] = process.argv.slice(2);
const cmp = [];
for (const f of fs.readdirSync(mmDir).filter((f) => f.startsWith("compare."))) {
  for (const l of fs.readFileSync(path.join(mmDir, f), "utf8").split("\n")) if (l) cmp.push(JSON.parse(l));
}
const cases = cmp.filter((c) => c.outcome === "wrong_side" || c.outcome === "missed" || (c.lagSec != null && c.lagSec < -60));
const positions = new Set(cases.map((c) => c.position));

// Leader rebalance attempts (ok and failed) on those positions, from the recorder's tx shards.
const attempts = new Map(); // position -> [{t, ok, err}]
for (const f of fs.readdirSync(liveDir).filter((f) => f.startsWith("tx.") && f.endsWith(".gz")).sort()) {
  for await (const line of gzLines(path.join(liveDir, f))) {
    let tx; try { tx = JSON.parse(line); } catch { continue; }
    let d; try { d = decodeMeteoraTx(tx); } catch { continue; }
    const rb = d.find((x) => x.kind === "ix" && x.name === "rebalance_liquidity");
    if (!rb || !positions.has(rb.accounts.position)) continue;
    const a = attempts.get(rb.accounts.position) ?? [];
    a.push({ t: tx.blockTime, ok: !tx.meta.err, err: tx.meta.err ? JSON.stringify(tx.meta.err).slice(0, 60) : null });
    attempts.set(rb.accounts.position, a);
  }
}

const tally = { tried_and_failed: 0, no_attempt: 0, no_window: 0 };
const errs = new Map();
for (const c of cases) {
  const from = c.ours?.t, to = c.t;
  if (from == null || from >= to) { tally.no_window++; continue; }
  const inWin = (attempts.get(c.position) ?? []).filter((a) => a.t >= from - 2 && a.t < to);
  const failed = inWin.filter((a) => !a.ok);
  if (failed.length) { tally.tried_and_failed++; for (const f of failed) errs.set(f.err, (errs.get(f.err) ?? 0) + 1); }
  else tally.no_attempt++;
}
console.log("incelenen vaka:", cases.length, "(wrong_side / missed / lider ≥60 sn sonra)");
console.log(tally);
console.log("pencere içindeki başarısız deneme hataları:", [...errs].sort((a, b) => b[1] - a[1]).slice(0, 5));
const byPool = new Map(); for (const c of cases) byPool.set(c.pool, (byPool.get(c.pool) ?? 0) + 1);
console.log("havuz başına vaka:", [...byPool].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([p, n]) => `${p.slice(0, 6)}:${n}`).join(" "));
