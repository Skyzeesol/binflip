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
} from "@binflip/core";

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

await runService("mm", async ({ config, log }) => {
  if (config.mode === "live") throw new Error("mm has no live mode yet: run it with DRY_RUN=1 (shadow only)");
  const rpc = new SolanaRpc(config.SOLANA_RPC_URL, { retries: 6, timeoutMs: 20_000 });
  const book = new ShadowBook();
  const binSteps = new Map<string, number>();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const day = () => new Date().toISOString().slice(0, 10);
  const write = (kind: string, obj: unknown) =>
    fs.appendFileSync(path.join(OUT_DIR, `${kind}.${day()}.jsonl`), JSON.stringify(obj) + "\n");

  // ── pool state ──────────────────────────────────────────────────────────────
  async function readPools(pools: string[]): Promise<Map<string, { activeId: number; binStep: number }>> {
    const out = new Map<string, { activeId: number; binStep: number }>();
    for (let i = 0; i < pools.length; i += 100) {
      const chunk = pools.slice(i, i + 100);
      const res = await rpc.call<{ value: Array<{ data: [string, string] } | null> }>("getMultipleAccounts", [
        chunk,
        { encoding: "base64", commitment: "confirmed" },
      ]);
      res.value.forEach((acc, j) => {
        if (!acc) return;
        try {
          const s = decodeLbPair(Buffer.from(acc.data[0], "base64"));
          out.set(chunk[j]!, s);
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
  let cursor: string | undefined;
  const seen = new Set<string>();

  async function handleTx(tx: RawTransaction): Promise<void> {
    if ((tx.meta as { err?: unknown }).err) return;
    const t = (tx as { blockTime?: number }).blockTime ?? Math.floor(Date.now() / 1000);
    const decoded = decodeMeteoraTx(tx).filter((d) => d.protocol === "dlmm");
    const ixs = decoded.filter((d): d is DecodedIx => d.kind === "ix");
    const evs = decoded.filter((d): d is DecodedEvent => d.kind === "event");
    const str = (v: unknown) => (v && typeof (v as { toBase58?: () => string }).toBase58 === "function" ? (v as { toBase58: () => string }).toBase58() : String(v));
    const big = (v: unknown) => BigInt(String(v ?? 0));

    for (const e of evs) {
      if (e.name === "Rebalancing") {
        const d = e.data;
        const position = str(d.position), pool = str(d.lb_pair);
        if (str(d.owner) !== LEADER) continue;
        const bs = await binStepOf(pool);
        if (!bs) continue;
        const next: MmRange = { lower: Number(d.new_min_id), upper: Number(d.new_max_id), side: big(d.x_added_amount) > 0n ? "token" : "sol" };
        const cmp = book.onLeaderRebalance({ position, pool, binStep: bs, t, active: Number(d.active_bin_id), old: { lower: Number(d.old_min_id), upper: Number(d.old_max_id) }, next });
        write("compare", { sig: tx.signature, ...cmp });
      } else if (e.name === "PositionClose") {
        const position = str(e.data.position);
        if (book.onClose(position)) write("leader", { t, sig: tx.signature, kind: "close", position });
      }
    }

    // Opens: initialize_position* gives the range, AddLiquidity tells the side.
    const init = ixs.find((d) => d.name.startsWith("initialize_position"));
    if (init) {
      const position = init.accounts.position, pool = init.accounts.lb_pair;
      if (position && pool && !book.has(position)) {
        const bs = await binStepOf(pool);
        const lower = Number(init.args.lower_bin_id), width = Number(init.args.width);
        const add = evs.find((e) => e.name === "AddLiquidity");
        const amounts = (add?.data.amounts as unknown[] | undefined) ?? [];
        const side = big(amounts[0]) > 0n && big(amounts[1]) === 0n ? "token" : "sol";
        if (bs && Number.isFinite(lower) && width > 0) {
          book.onOpen({ position, pool, binStep: bs, range: { lower, upper: lower + width - 1, side }, t });
          write("leader", { t, sig: tx.signature, kind: "open", position, pool, binStep: bs, lower, width, side, amountY: String(amounts[1] ?? "0") });
        }
      }
    }
  }

  async function pollLeader(): Promise<void> {
    const sigs = await rpc.getSignaturesForAddress(LEADER, { limit: 200, ...(cursor ? { until: cursor } : {}) });
    if (!sigs.length) return;
    const first = !cursor;
    cursor = sigs[0]!.signature;
    if (first) return; // start from "now"; positions opened earlier are adopted on their next rebalance
    for (const s of sigs.reverse()) {
      if (seen.has(s.signature) || s.err) continue;
      seen.add(s.signature);
      const tx = await rpc.getTransaction(s.signature);
      if (tx) await handleTx(tx);
    }
    if (seen.size > 50_000) seen.clear();
  }

  // ── loops ───────────────────────────────────────────────────────────────────
  let stopped = false;
  let lastTickOk = Date.now();
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

  loop("leader", TX_POLL_MS, pollLeader);
  loop("tick", TICK_MS, async () => {
    const pools = book.pools();
    if (!pools.length) return;
    const states = await readPools(pools);
    const now = Math.floor(Date.now() / 1000);
    for (const [pool, s] of states) {
      for (const d of book.onTick(pool, s.activeId, now)) write("ours", { t: now, pool, active: s.activeId, ...d });
    }
    lastTickOk = Date.now();
  });
  const statsTimer = setInterval(() => {
    const s = book.summary();
    log.info(s, "shadow stats");
    write("stats", { t: Math.floor(Date.now() / 1000), ...s });
  }, STATS_MS);

  log.info({ leader: LEADER, tickMs: TICK_MS, outDir: OUT_DIR }, "shadow mode: following leader, no transactions are sent");
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
      },
    ],
  };
});
