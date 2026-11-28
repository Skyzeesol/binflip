// The leader's result in one pool over a time window, from the recorder archive, to compare a
// pilot position with the leader's own position in the same pool.
//
//   node pilot_compare.mjs <recorder dir> <pool> <fromISO> <toISO> [sellWindowMin=60]
//
// Per leader position in the pool: lot (SOL added at the open / funding), the SOL that came back
// over all its txs (rebalances, claims, close) plus the SOL from selling THAT token afterwards
// (swaps of the mint within sellWindowMin after the close), token left unsold, net as % of lot.
import fs from "node:fs";
import path from "node:path";
import { gzLines } from "./gzlines.mjs";
import { decodeMeteoraTx } from "../../packages/core/dist/meteora/decode.js";

const [dir, pool, fromIso, toIso, sellMin] = process.argv.slice(2);
const L = process.env.LEADER ?? "BviQcBvnWv5HHxHcouTwRFhrAMPNKuMLzEaSuxCuv6eU";
const t0 = Date.parse(fromIso) / 1000, t1 = Date.parse(toIso) / 1000, sellSec = Number(sellMin ?? 60) * 60;
const hourOf = (f) => { const h = f.split(".")[1]; return Date.parse(`${h.slice(0, 4)}-${h.slice(4, 6)}-${h.slice(6, 8)}T${h.slice(8, 10)}:00:00Z`) / 1000; };
const shards = fs.readdirSync(dir).filter((f) => f.startsWith("tx.") && f.endsWith(".jsonl.gz")).filter((f) => hourOf(f) + 3600 > t0 && hourOf(f) < t1 + sellSec).sort();

const rows = [];
for (const f of shards) for await (const line of gzLines(path.join(dir, f))) {
  let tx; try { tx = JSON.parse(line); } catch { continue; }
  if (!tx.blockTime || tx.blockTime < t0 || tx.blockTime > t1 + sellSec || tx.meta?.err) continue;
  const keys = [...tx.transaction.message.accountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
  const wi = keys.indexOf(L);
  if (wi < 0) continue;
  const tok = {};
  for (const b of tx.meta.preTokenBalances ?? []) if (b.owner === L) tok[b.mint] = (tok[b.mint] ?? 0n) - BigInt(b.uiTokenAmount.amount);
  for (const b of tx.meta.postTokenBalances ?? []) if (b.owner === L) tok[b.mint] = (tok[b.mint] ?? 0n) + BigInt(b.uiTokenAmount.amount);
  let dec = []; try { dec = decodeMeteoraTx(tx); } catch {}
  const inPool = dec.some((d) => (d.kind === "ix" && d.accounts.lb_pair === pool) || (d.kind === "event" && String(d.data.lb_pair) === pool));
  const positions = [...new Set(dec.filter((d) => d.kind === "ix" && d.accounts.position && d.accounts.lb_pair === pool).map((d) => d.accounts.position))];
  const evs = dec.filter((d) => d.kind === "event");
  rows.push({ sig: tx.signature, t: tx.blockTime, sol: tx.meta.postBalances[wi] - tx.meta.preBalances[wi], tok, inPool, positions, evs, names: dec.filter((d) => d.kind === "ix" && d.innerIndex === null).map((d) => d.name).join("+") });
}
rows.sort((a, b) => a.t - b.t);
// the pool's token = the mint whose balance the leader's pool txs move
const mintCount = {};
for (const r of rows.filter((x) => x.inPool)) for (const m of Object.keys(r.tok)) if (m !== "So11111111111111111111111111111111111111112") mintCount[m] = (mintCount[m] ?? 0) + 1;
const mint = Object.entries(mintCount).sort((a, b) => b[1] - a[1])[0]?.[0];
console.log(`pool ${pool}  token ${mint ?? "?"}  window ${fromIso} → ${toIso}  leader txs read ${rows.length}`);

const byPos = new Map();
for (const r of rows.filter((x) => x.inPool && x.t <= t1)) for (const p of r.positions) {
  const a = byPos.get(p) ?? { txs: [], lot: 0n };
  a.txs.push(r);
  byPos.set(p, a);
}
for (const [p, a] of byPos) {
  const shared = a.txs.filter((r) => r.positions.length > 1).length;
  for (const r of a.txs) for (const e of r.evs) {
    if (String(e.data.position) !== p) continue;
    if (e.name === "AddLiquidity" && /initialize/.test(r.names)) a.lot += BigInt(String(e.data.amounts[1] ?? 0));
    if (e.name === "Rebalancing" && /initialize/.test(r.names)) a.lot += BigInt(String(e.data.y_added_amount ?? 0));
  }
  const closed = a.txs.find((r) => r.evs.some((e) => e.name === "PositionClose" && String(e.data.position) === p));
  const own = a.txs.reduce((s, r) => s + r.sol, 0);
  let tokLeft = a.txs.reduce((s, r) => s + (r.tok[mint] ?? 0n), 0n);
  let sold = 0;
  const end = (closed?.t ?? t1) + sellSec;
  for (const r of rows) {
    if (r.inPool || !mint || !(r.tok[mint] < 0n) || r.t < a.txs[0].t || r.t > end) continue;
    sold += r.sol; tokLeft += r.tok[mint];
  }
  const lot = Number(a.lot) / 1e9;
  const net = (own + sold) / 1e9;
  console.log(`leader position ${p.slice(0, 8)}  ${new Date(a.txs[0].t * 1000).toISOString().slice(11, 19)} → ${closed ? new Date(closed.t * 1000).toISOString().slice(11, 19) : "still open"}  txs ${a.txs.length}${shared ? ` (${shared} shared with other positions)` : ""}  lot ${lot} SOL  SOL net ${net.toFixed(4)} (own ${(own / 1e9).toFixed(4)} + token sales ${(sold / 1e9).toFixed(4)})  = ${lot ? ((net / lot) * 100).toFixed(1) : "?"}% of lot  token left ${tokLeft}`);
}
