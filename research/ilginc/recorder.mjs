// Live recorder for the BviQ study (aşama 4). Runs 24/7 on the VPS.
//
// Writes hourly gzip shards under $OUT (default ./live):
//   tx.<hour>.jsonl.gz     every BviQ transaction (same shape as txs.mjs: {signature, ...getTransaction})
//   pool.<hour>.jsonl.gz   {t, slot, pools:{addr:[activeId, volatilityAccumulator, idReference, lastUpdate]}}
//                          for every pool the wallet touched recently, every POOL_MS
//   universe.<hour>.jsonl.gz  Meteora top pools snapshot every UNIVERSE_MS (to compare picks vs. skips)
//
// Each record is its own gzip member, so a crash never corrupts a shard.
// Env: RPC_URL, WALLETS (comma list), OUT, POOL_MS (2000), UNIVERSE_MS (300000), TX_POLL_MS (3000)
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
const UNIVERSE_MS = +(process.env.UNIVERSE_MS || 300000);
const TX_POLL_MS = +(process.env.TX_POLL_MS || 3000);
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
const stats = { tx: 0, poolSnaps: 0, universe: 0, errors: 0 };

// ── wallet transactions ────────────────────────────────────────────────────────
const pools = new Map(); // pool -> last touched ms
const seen = new Set();
const cursor = new Map(); // wallet -> newest signature seen
async function pollWallet(w) {
  const until = cursor.get(w);
  const sigs = [];
  let before;
  for (let page = 0; page < 10; page++) {
    const batch = await rpc("getSignaturesForAddress", [w, { limit: 1000, before, until }]);
    sigs.push(...batch);
    if (batch.length < 1000 || !until) break; // first run: only the newest page
    before = batch.at(-1).signature;
  }
  if (sigs.length) cursor.set(w, sigs[0].signature);
  for (const s of sigs.reverse()) {
    if (seen.has(s.signature)) continue;
    seen.add(s.signature);
    let tx = null;
    for (let k = 0; k < 6 && !tx; k++) {
      tx = await rpc("getTransaction", [s.signature, { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed" }]);
      if (!tx) await sleep(1000);
    }
    if (!tx) { stats.errors++; continue; }
    write("tx", { signature: s.signature, wallet: w, recvMs: Date.now(), ...tx });
    stats.tx++;
    try {
      for (const d of decodeMeteoraTx(tx)) {
        const p = d.kind === "ix" ? d.accounts.lb_pair : d.data?.lb_pair?.toBase58?.();
        if (p) pools.set(p, Date.now());
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
      const out = [];
      for (let page = 1; page <= 5; page++) {
        const r = await fetch(`https://dlmm.datapi.meteora.ag/pools?page=${page}&page_size=100&sort_by=volume_1h:desc`, { signal: AbortSignal.timeout(30000) });
        if (!r.ok) throw new Error(`universe http ${r.status}`);
        const j = await r.json();
        const rows = j.data ?? j.pools ?? j;
        if (!Array.isArray(rows) || !rows.length) break;
        for (const p of rows) out.push({
          a: p.address, n: p.name, x: p.token_x?.address, y: p.token_y?.address, bs: p.pool_config?.bin_step, bf: p.pool_config?.base_fee_pct,
          df: p.dynamic_fee_pct, tvl: p.tvl, mc: p.token_x?.market_cap, h: p.token_x?.holders, c: p.created_at,
          v: p.volume, f: p.fees, ftr: p.fee_tvl_ratio, px: p.current_price, lp: p.launchpad, tg: p.tags,
        });
      }
      write("universe", { t: t0, pools: out });
      stats.universe++;
    } catch (e) { stats.errors++; log("universe", e.message); }
    await sleep(Math.max(0, UNIVERSE_MS - (Date.now() - t0)));
  }
}

setInterval(() => log("stats", JSON.stringify({ ...stats, trackedPools: pools.size })), 60000).unref();
log("recorder start", { WALLETS, OUT, POOL_MS, UNIVERSE_MS });
await Promise.all([walletLoop(), poolLoop(), universeLoop()]);
