import fs from "node:fs";
import path from "node:path";
import {
  ShadowBook,
  SolanaRpc,
  decodeLbPair,
  decodeMeteoraTx,
  runService,
  type DecodedEvent,
  type DecodedIx,
  type MmRange,
  type RawTransaction,
  wsUrlFromHttp,
  DlmmTxBuilder,
  KeystoreSigner,
  TxSender,
  createConnection,
  readPassphraseFile,
} from "@binflip/core";
import { AccountWatcher } from "./accountWatcher.js";
import { LiveMm } from "./live.js";
import { serviceTick } from "./tick.js";
import { leaderEvents, liveOpenAllowed } from "./leaderEvents.js";
import { LeaderFeed } from "./leaderFeed.js";
import { SlotGate } from "./slotGate.js";
import { PublicKey } from "@solana/web3.js";

/**
 * mm — İlginç (BviQ) market-making engine, SHADOW mode.
 *
 * Mirrors the leader's open positions, reads each pool's active bin every MM_TICK_MS,
 * runs the engine (packages/core/src/mm) and scores every leader rebalance against our
 * own decision. Sends no transactions. Output: JSONL in MM_OUT_DIR + a stats line per minute.
 */
const LEADER = process.env.MM_LEADER ?? "BviQcBvnWv5HHxHcouTwRFhrAMPNKuMLzEaSuxCuv6eU";
const TICK_MS = Number(process.env.MM_TICK_MS ?? 2000);
const TX_POLL_MS = Number(process.env.MM_TX_POLL_MS ?? 3000);
const OUT_DIR = process.env.MM_OUT_DIR ?? "mm-data";
const STATS_MS = Number(process.env.MM_STATS_MS ?? 60_000);
/** Pool reads: WebSocket push (MM_WS=1, default) + this poll as a fallback. */
const USE_WS = (process.env.MM_WS ?? "1") !== "0";
const COMMITMENT = (process.env.MM_COMMITMENT ?? "processed") as "processed" | "confirmed";

await runService("mm", async ({ config, log }) => {
  // Live needs BOTH Binflip's live gates (DRY_RUN=0 + LIVE_CONFIRMED=1) AND MM_LIVE=1.
  const wantLive = process.env.MM_LIVE === "1";
  if (config.mode === "live" && !wantLive) throw new Error("live mode without MM_LIVE=1: refusing (set MM_LIVE=1 to trade, or DRY_RUN=1 for shadow only)");
  if (wantLive && config.mode !== "live") throw new Error("MM_LIVE=1 needs DRY_RUN=0 and LIVE_CONFIRMED=1");
  const rpc = new SolanaRpc(config.SOLANA_RPC_URL, { retries: 6, timeoutMs: 20_000 });
  const book = new ShadowBook();
  let live: LiveMm | null = null;
  if (wantLive) {
    if (!config.KEYSTORE_PATH || !config.KEYSTORE_PASSPHRASE_FILE) throw new Error("MM_LIVE=1 needs KEYSTORE_PATH and KEYSTORE_PASSPHRASE_FILE");
    const signer = KeystoreSigner.fromFile(config.KEYSTORE_PATH, readPassphraseFile(config.KEYSTORE_PASSPHRASE_FILE));
    await signer.selfTest();
    const conn = createConnection(config.SOLANA_RPC_URL, config.SOLANA_WS_URL);
    const owner = new PublicKey(signer.publicKey);
    const sol = (v: string | undefined, d: number) => BigInt(Math.round(Number(v ?? d) * 1e9));
    live = new LiveMm(new DlmmTxBuilder(conn, owner), new TxSender(conn, signer), owner, {
      lotLamports: sol(process.env.MM_LOT_SOL, 0.1),
      maxPositions: Number(process.env.MM_MAX_POSITIONS ?? 3),
      reserveLamports: sol(process.env.MM_RESERVE_SOL, 0.15),
      slippageBins: Number(process.env.MM_SLIPPAGE_BINS ?? 0),
      priorityMicroLamports: Number(process.env.MM_PRIORITY_MICROLAMPORTS ?? 10_000),
      stateFile: path.join(OUT_DIR, "live-state.json"),
      killFile: process.env.MM_KILL_FILE ?? path.join(OUT_DIR, "STOP"),
      closeAllFile: process.env.MM_CLOSE_ALL_FILE ?? path.join(OUT_DIR, "CLOSE_ALL"),
    }, log, (kind, obj) => write(kind, obj));
    const balance = await conn.getBalance(owner);
    log.warn({ wallet: signer.publicKey, balanceSol: balance / 1e9, lotSol: Number(process.env.MM_LOT_SOL ?? 0.1), maxPositions: Number(process.env.MM_MAX_POSITIONS ?? 3) }, "LIVE: mm will send transactions");
  }
  const binSteps = new Map<string, number>();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const day = () => new Date().toISOString().slice(0, 10);
  const write = (kind: string, obj: unknown) =>
    fs.appendFileSync(path.join(OUT_DIR, `${kind}.${day()}.jsonl`), JSON.stringify(obj) + "\n");

  // ── pool state ──────────────────────────────────────────────────────────────
  async function readPools(pools: string[]): Promise<Map<string, { activeId: number; binStep: number; slot: number }>> {
    const out = new Map<string, { activeId: number; binStep: number; slot: number }>();
    for (let i = 0; i < pools.length; i += 100) {
      const chunk = pools.slice(i, i + 100);
      const res = await rpc.call<{ context: { slot: number }; value: Array<{ data: [string, string] } | null> }>("getMultipleAccounts", [
        chunk,
        { encoding: "base64", commitment: COMMITMENT },
      ]);
      res.value.forEach((acc, j) => {
        if (!acc) return;
        try {
          const s = decodeLbPair(Buffer.from(acc.data[0], "base64"));
          out.set(chunk[j]!, { ...s, slot: res.context.slot });
          binSteps.set(chunk[j]!, s.binStep);
        } catch (err) {
          log.debug({ err, pool: chunk[j] }, "lb pair decode failed");
        }
      });
    }
    return out;
  }

  async function binStepOf(pool: string): Promise<number | undefined> {
    if (!binSteps.has(pool)) await readPools([pool]);
    return binSteps.get(pool);
  }

  // ── leader transactions ─────────────────────────────────────────────────────
  // Durable feed (cursor + replay guard persisted; paged history; unreadable txs parked and
  // retried without blocking) → leaderEvents (strict open matching) → shadow book + live.
  async function handleTx(tx: RawTransaction, info: { signature: string; slot: number; late: boolean }): Promise<void> {
    if ((tx.meta as { err?: unknown } | null)?.err) return;
    const blockTime = (tx as { blockTime?: number | null }).blockTime ?? undefined;
    const t = blockTime ?? Math.floor(Date.now() / 1000); // shadow scoring only; live opens need a real block time
    for (const ev of leaderEvents(decodeMeteoraTx(tx), LEADER)) {
      if (ev.kind === "rebalance") {
        const bs = await binStepOf(ev.pool);
        if (!bs) continue;
        const cmp = book.onLeaderRebalance({ position: ev.position, pool: ev.pool, binStep: bs, t, slot: tx.slot, active: ev.active, old: ev.old, next: ev.next });
        write("compare", { sig: info.signature, late: info.late || undefined, ...cmp });
      } else if (ev.kind === "close") {
        await live?.onLeaderClose(ev.position); // persists the close intent before returning
        const closed = book.onClose(ev.position, t);
        if (closed) {
          write("leader", { t, sig: info.signature, kind: "close", position: ev.position });
          write("exits", { sig: info.signature, ...closed.exit });
        }
      } else if (!book.has(ev.position)) {
        const bs = await binStepOf(ev.pool);
        if (!bs) continue;
        write("leader", { t, sig: info.signature, kind: "open", position: ev.position, pool: ev.pool, binStep: bs, lower: ev.lower, width: ev.width, side: ev.side, amountX: ev.amountX.toString(), amountY: ev.amountY.toString(), blockTime: blockTime ?? null, late: info.late || undefined });
        if (ev.side === "sol" || ev.side === "token") book.onOpen({ position: ev.position, pool: ev.pool, binStep: bs, range: { lower: ev.lower, upper: ev.lower + ev.width - 1, side: ev.side }, t });
        if (live && liveOpenAllowed(ev, blockTime, Math.floor(Date.now() / 1000), info.late)) void live.onLeaderOpen({ leaderPosition: ev.position, pool: ev.pool, t: blockTime! });
      }
    }
  }

  const feed = new LeaderFeed(
    {
      getSignaturesForAddress: (a, o) => rpc.getSignaturesForAddress(a, o) as never,
      getTransaction: (sig) => rpc.getTransaction(sig) as never,
    },
    LEADER,
    path.join(OUT_DIR, "leader-feed.json"),
    (tx, info) => handleTx(tx as unknown as RawTransaction, info),
    {
      onUnreadable: (signature, tries) => {
        log.warn({ signature, tries }, "leader tx never became readable; reconciling copied positions from chain");
        write("skipped", { t: Math.floor(Date.now() / 1000), signature, tries });
        void live?.reconcileLeaderPositions("unreadable_tx");
      },
      onGap: (fetched) => {
        log.warn({ fetched }, "leader history longer than the page limit; reconciling copied positions from chain");
        void live?.reconcileLeaderPositions("history_gap");
      },
    },
  );
  const pollLeader = async () => {
    await feed.poll();
    lastLeaderOk = Date.now();
  };
  await live?.reconcileLeaderPositions("startup");

  // ── loops ───────────────────────────────────────────────────────────────────
  let stopped = false;
  let lastTickOk = Date.now();
  let lastLeaderOk = Date.now();
  const gate = new SlotGate(); // one slot order for WS pushes and RPC polls
  const loop = (name: string, ms: number, fn: () => Promise<void>) => {
    (async () => {
      while (!stopped) {
        const t0 = Date.now();
        try {
          await fn();
        } catch (err) {
          log.warn({ err, loop: name }, "loop error");
        }
        await new Promise((r) => setTimeout(r, Math.max(0, ms - (Date.now() - t0))));
      }
    })();
  };

  // Push path: every pool change (a swap moving the active bin) runs the engine at once.
  const watcher = USE_WS
    ? new AccountWatcher(config.SOLANA_WS_URL ?? wsUrlFromHttp(config.SOLANA_RPC_URL), log, (pool, data, slot) => {
        try {
          const s = decodeLbPair(Buffer.from(data, "base64"));
          binSteps.set(pool, s.binStep);
          const now = Math.floor(Date.now() / 1000);
          if (!gate.accept(pool, slot || undefined)) return; // older than what we already acted on
          for (const d of book.onTick(pool, s.activeId, now, slot)) write("ours", { t: now, slot, pool, active: s.activeId, via: "ws", ...d });
          live?.onTick(pool, s.activeId);
          lastTickOk = Date.now();
        } catch (err) {
          log.debug({ err, pool }, "ws decode failed");
        }
      }, COMMITMENT)
    : null;
  watcher?.start();

  loop("leader", TX_POLL_MS, pollLeader);
  loop("tick", TICK_MS, async () => {
    await serviceTick({ book, live, watcher, readPools, write, gate });
    lastTickOk = Date.now();
  });
  const statsTimer = setInterval(() => {
    const s = { ...book.summary(), liveOpen: live?.openCount ?? null, wsConnected: watcher?.connected ?? null, wsNotifications: watcher?.notifications ?? null };
    log.info(s, "shadow stats");
    write("stats", { t: Math.floor(Date.now() / 1000), ...s });
  }, STATS_MS);

  log.info({ leader: LEADER, tickMs: TICK_MS, ws: USE_WS, commitment: COMMITMENT, outDir: OUT_DIR }, "shadow mode: following leader, no transactions are sent");
  return {
    checks: {
      tick: async () => {
        if (book.pools().length && Date.now() - lastTickOk > 60_000) throw new Error("no pool read for 60s");
      },
    },
    cleanups: [
      () => {
        stopped = true;
        clearInterval(statsTimer);
        watcher?.close();
      },
    ],
  };
});
