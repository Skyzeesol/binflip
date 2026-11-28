// Live recorder for the BviQ study (aşama 4). Runs 24/7 on the VPS.
//
// Writes hourly gzip shards under $OUT (default ./live):
//   tx.<hour>.jsonl.gz     every BviQ transaction (same shape as txs.mjs: {signature, ...getTransaction})
//   pool.<hour>.jsonl.gz   {t, slot, pools:{addr:[activeId, volatilityAccumulator, idReference, lastUpdate]}}
//                          for every pool the wallet touched recently, every POOL_MS
//   universe.<hour>.jsonl.gz  Meteora pool snapshot every UNIVERSE_MS: top by 1h volume + top by 30m/1h fee/TVL, merged
//   dex.<hour>.jsonl.gz    DexScreener (5m/1h volume, 5m txns, price change, liquidity, mcap):
//                          kind "tracked" = pools the wallet touched, every DEX_TRACKED_MS;
//                          kind "universe" = every universe pool, right after each universe snapshot
//   event.<hour>.jsonl.gz  the moment the wallet OPENS or CLOSES a position: full Meteora pool
//                          record + DexScreener pair for that pool (the "photo" at the decision)
//
// Each record is its own gzip member, so a crash never corrupts a shard.
// Env: RPC_URL, WALLETS (comma list), OUT, POOL_MS (2000), UNIVERSE_MS (120000), TX_POLL_MS (3000)
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import { rpc, sleep } from "./rpc.mjs";
import { decodeMeteoraTx } from "../../packages/core/dist/meteora/decode.js";

// Resolve SDKs through packages/core (research/ has no package.json of its own).
const require = createRequire(new URL("../../packages/core/package.json", import.meta.url));
const { BorshCoder } = require("@coral-xyz/anchor");
const coder = new BorshCoder(require("@meteora-ag/dlmm").IDL);
const WALLETS = (process.env.WALLETS || "BviQcBvnWv5HHxHcouTwRFhrAMPNKuMLzEaSuxCuv6eU").split(",");
const OUT = process.env.OUT || "live";
const POOL_MS = +(process.env.POOL_MS || 2000);
const UNIVERSE_MS = +(process.env.UNIVERSE_MS || 120000);
// [sort_by, pages of 100]
const UNIVERSE_SORTS = [["volume_1h:desc", 5], ["fee_tvl_ratio_30m:desc", 3], ["fee_tvl_ratio_1h:desc", 2]];
const TX_POLL_MS = +(process.env.TX_POLL_MS || 3000);
const DEX_TRACKED_MS = +(process.env.DEX_TRACKED_MS || 60000);
const EVENT_MAX_AGE_SEC = +(process.env.EVENT_MAX_AGE_SEC || 120);
const POOL_TTL_MS = 3 * 3600 * 1000; // keep sampling a pool 3h after the wallet last touched it
fs.mkdirSync(OUT, { recursive: true });

const hour = () => new Date().toISOString().slice(0, 13).replace(/[-:T]/g, "");
const fds = new Map();
function write(kind, obj) {
  const name = `${kind}.${hour()}.jsonl.gz`;
  let fd = fds.get(kind);
  if (!fd || fd.name !== name) {
    if (fd) fs.closeSync(fd.fd);
    fd = { name, fd: fs.openSync(path.join(OUT, name), "a") };
    fds.set(kind, fd);
  }
  fs.writeSync(fd.fd, zlib.gzipSync(JSON.stringify(obj) + "\n"));
}
const log = (...a) => console.log(new Date().toISOString(), ...a);
const stats = { tx: 0, poolSnaps: 0, universe: 0, dex: 0, events: 0, errors: 0 };

// ── DexScreener / Meteora snapshots ────────────────────────────────────────────
const compactPair = (p) => ({
  a: p.pairAddress, v: p.volume, tx: p.txns, pc: p.priceChange, liq: p.liquidity?.usd, lq: p.liquidity?.quote,
  mc: p.marketCap, fdv: p.fdv, px: p.priceUsd, created: p.pairCreatedAt,
});
async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`${new URL(url).host} http ${r.status}`);
  return r.json();
}
/** DexScreener pairs, 30 per request (their batch limit). */
async function dexPairs(addrs) {
  const out = [];
  for (let i = 0; i < addrs.length; i += 30) {
    const j = await getJson(`https://api.dexscreener.com/latest/dex/pairs/solana/${addrs.slice(i, i + 30).join(",")}`);
    for (const p of j.pairs ?? []) out.push(compactPair(p));
    await sleep(250); // ~240 req/min ceiling vs their 300
  }
  return out;
}
/** The "photo" at an open/close: everything Meteora and DexScreener know about the pool right now. */
async function snapshotEvent(e) {
  try {
    const [meteora, dex] = await Promise.all([
      getJson(`https://dlmm.datapi.meteora.ag/pools/${e.pool}`).catch((err) => ({ error: err.message })),
      dexPairs([e.pool]).catch((err) => [{ error: err.message }]),
    ]);
    // Taken AFTER the decision (the tx is already on chain): describes the pool right after it.
    // Not decision-time data: analyses must not use it as an input of the decision.
    const snapMs = Date.now();
    write("event", { ...e, snapMs, snapLagSec: e.blockTime ? Math.round(snapMs / 1000 - e.blockTime) : null, postDecision: true, meteora, dex: dex[0] ?? null });
    stats.events++;
  } catch (err) { stats.errors++; log("event", err.message); }
}

// ── wallet transactions ────────────────────────────────────────────────────────
const pools = new Map(); // pool -> last touched ms
const seen = new Set();
const cursor = new Map(); // wallet -> newest signature WRITTEN (moves only after the tx is in the archive)
const misses = new Map(); // signature -> polls it could not be read; after MAX_MISSES it is recorded as a gap
const MAX_MISSES = +(process.env.MAX_MISSES || 20);
async function pollWallet(w) {
  const until = cursor.get(w);
  const sigs = [];
  let before;
  for (let page = 0; page < 10; page++) {
    // First run: only a short look back, so live decisions are not stuck behind a backlog
    // (txs.mjs can fill any gap from a restart afterwards).
    const batch = await rpc("getSignaturesForAddress", [w, { limit: until ? 1000 : 100, before, until }]);
    sigs.push(...batch);
    if (batch.length < 1000 || !until) break; // first run: only the newest page
    before = batch.at(-1).signature;
  }
  // Oldest first; the cursor moves past a signature only once its tx is written. A transient
  // RPC error stops this pass (the rest is read next poll) instead of leaving a permanent hole;
  // a tx that stays unreadable for MAX_MISSES polls is written as a "gap" record, visibly.
  for (const s of sigs.reverse()) {
    if (seen.has(s.signature)) { cursor.set(w, s.signature); continue; }
    let tx = null;
    for (let k = 0; k < 3 && !tx; k++) {
      tx = await rpc("getTransaction", [s.signature, { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed" }]);
      if (!tx) await sleep(1000);
    }
    if (!tx || !tx.meta) {
      const n = (misses.get(s.signature) ?? 0) + 1;
      misses.set(s.signature, n);
      stats.errors++;
      if (n < MAX_MISSES) break; // retry from here on the next poll
      write("gap", { t: Date.now(), wallet: w, signature: s.signature, slot: s.slot, blockTime: s.blockTime ?? null, misses: n });
      misses.delete(s.signature);
      seen.add(s.signature);
      cursor.set(w, s.signature);
      continue;
    }
    write("tx", { signature: s.signature, wallet: w, recvMs: Date.now(), ...tx });
    seen.add(s.signature);
    misses.delete(s.signature);
    cursor.set(w, s.signature);
    stats.tx++;
    try {
      const decoded = decodeMeteoraTx(tx);
      for (const d of decoded) {
        const p = d.kind === "ix" ? d.accounts.lb_pair : d.data?.lb_pair?.toBase58?.();
        if (p) pools.set(p, Date.now());
      }
      // Photos only for fresh decisions: a backlog (e.g. right after a restart) would get today's
      // numbers attached to an old decision, which is worse than no photo.
      const ageSec = Date.now() / 1000 - (tx.blockTime ?? 0);
      if (!tx.meta?.err && ageSec <= EVENT_MAX_AGE_SEC) {
        const base = { wallet: w, sig: s.signature, blockTime: tx.blockTime, recvMs: Date.now() };
        const txPool = decoded.find((x) => x.kind === "ix" && x.accounts.lb_pair)?.accounts.lb_pair ?? null;
        const init = decoded.find((d) => d.kind === "ix" && d.name.startsWith("initialize_position"));
        if (init?.accounts.lb_pair) snapshotEvent({ ...base, kind: "open", pool: init.accounts.lb_pair, position: init.accounts.position });
        for (const d of decoded) {
          if (d.kind === "event" && d.name === "PositionClose") {
            snapshotEvent({ ...base, kind: "close", pool: txPool, position: d.data.position?.toBase58?.() ?? String(d.data.position) });
          }
        }
      }
    } catch {}
  }
  if (seen.size > 200000) seen.clear();
}
async function walletLoop() {
  for (;;) {
    for (const w of WALLETS) {
      try { await pollWallet(w); } catch (e) { stats.errors++; log("wallet", w, e.message); }
    }
    await sleep(TX_POLL_MS);
  }
}

// ── pool state sampling ────────────────────────────────────────────────────────
async function poolLoop() {
  for (;;) {
    const t0 = Date.now();
    for (const [p, ts] of pools) if (t0 - ts > POOL_TTL_MS) pools.delete(p);
    const list = [...pools.keys()];
    try {
      const snap = {};
      let slot = null;
      for (let i = 0; i < list.length; i += 100) {
        const chunk = list.slice(i, i + 100);
        const res = await rpc("getMultipleAccounts", [chunk, { encoding: "base64", commitment: "confirmed" }]);
        slot = res.context.slot;
        res.value.forEach((acc, j) => {
          if (!acc) return;
          try {
            const d = coder.accounts.decode("LbPair", Buffer.from(acc.data[0], "base64"));
            const v = d.v_parameters;
            snap[chunk[j]] = [d.active_id, v.volatility_accumulator, v.index_reference, Number(v.last_update_timestamp)];
          } catch {}
        });
      }
      if (list.length) { write("pool", { t: t0, slot, pools: snap }); stats.poolSnaps++; }
    } catch (e) { stats.errors++; log("pool", e.message); }
    await sleep(Math.max(0, POOL_MS - (Date.now() - t0)));
  }
}

// ── candidate universe ─────────────────────────────────────────────────────────
async function universeLoop() {
  for (;;) {
    const t0 = Date.now();
    try {
      // Several rankings, merged: the busiest pools AND the best fee/TVL ones (small new
      // pools with high fees rarely make the top of a volume list, but BviQ enters them).
      const out = [];
      const have = new Set();
      for (const [sort, pages] of UNIVERSE_SORTS) {
        for (let page = 1; page <= pages; page++) {
          let j;
          try {
            j = await getJson(`https://dlmm.datapi.meteora.ag/pools?page=${page}&page_size=100&sort_by=${sort}`);
          } catch (err) { stats.errors++; log("universe", sort, page, err.message); break; } // keep the other rankings
          const rows = j.data ?? j.pools ?? j;
          if (!Array.isArray(rows) || !rows.length) break;
          for (const p of rows) {
            if (have.has(p.address)) continue;
            have.add(p.address);
            out.push({
              a: p.address, n: p.name, x: p.token_x?.address, y: p.token_y?.address, bs: p.pool_config?.bin_step, bf: p.pool_config?.base_fee_pct,
              df: p.dynamic_fee_pct, tvl: p.tvl, mc: p.token_x?.market_cap, h: p.token_x?.holders, c: p.created_at,
              v: p.volume, f: p.fees, ftr: p.fee_tvl_ratio, px: p.current_price, lp: p.launchpad, tg: p.tags, s: sort,
            });
          }
        }
      }
      if (out.length) {
        write("universe", { t: t0, pools: out });
        stats.universe++;
        try {
          write("dex", { t: Date.now(), kind: "universe", pairs: await dexPairs(out.map((p) => p.a)) });
          stats.dex++;
        } catch (err) { stats.errors++; log("dex universe", err.message); }
      }
    } catch (e) { stats.errors++; log("universe", e.message); }
    await sleep(Math.max(0, UNIVERSE_MS - (Date.now() - t0)));
  }
}

async function dexTrackedLoop() {
  for (;;) {
    const t0 = Date.now();
    const list = [...pools.keys()];
    if (list.length) {
      try { write("dex", { t: t0, kind: "tracked", pairs: await dexPairs(list) }); stats.dex++; }
      catch (err) { stats.errors++; log("dex tracked", err.message); }
    }
    await sleep(Math.max(0, DEX_TRACKED_MS - (Date.now() - t0)));
  }
}

setInterval(() => log("stats", JSON.stringify({ ...stats, trackedPools: pools.size })), 60000).unref();
log("recorder start", { WALLETS, OUT, POOL_MS, UNIVERSE_MS });
await Promise.all([walletLoop(), poolLoop(), universeLoop(), dexTrackedLoop()]);
