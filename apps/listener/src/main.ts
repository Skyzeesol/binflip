import { Queue, Worker } from "bullmq";
import { and, eq, isNull } from "drizzle-orm";
import { Redis } from "ioredis";
import {
  PROGRAM_IDS,
  QUEUES,
  SolanaRpc,
  decodeMeteoraTx,
  extractActions,
  jobId,
  runService,
  wsUrlFromHttp,
  type ExecutionJob,
  type SignatureJob,
  type LeaderAction,
  type RawTransaction,
  WSOL_MINT,
  leaderSoldKey,
} from "@binflip/core";
import { createDb, schema } from "@binflip/db";
import { LogsWatcher } from "./logsWatcher.js";

const METEORA_PROGRAMS = [PROGRAM_IDS.DLMM, PROGRAM_IDS.DAMM_V2];
/** Redis client used to flag leader token sells (set when the service starts). */
let sellFlags: Redis;
const REFRESH_LEADERS_MS = 30_000;

/**
 * listener — watches leader wallets and turns their Meteora transactions into
 * stored leader_events, one per (user, signature, position).
 *
 *   logsSubscribe (fast path) ─┐
 *   getSignaturesForAddress   ─┴→ [leader-signatures] → fetch + decode → leader_events → [execution]
 *   (gap recovery / reconnect)
 */
await runService("listener", async ({ config, log }) => {
  const { db, ping, close } = createDb(config.DATABASE_URL, { max: 5 });
  const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  sellFlags = connection;
  const rpc = new SolanaRpc(config.SOLANA_RPC_URL);
  const signatures = new Queue<SignatureJob>(QUEUES.LEADER_EVENTS, { connection });
  const execution = new Queue<ExecutionJob>(QUEUES.EXECUTION, { connection });

  /** address → followers (one row per user following it). */
  let followers = new Map<string, Array<{ userId: string; leaderId: string }>>();
  /** address → newest signature we have seen; the poller fetches until it. */
  const cursorKey = (address: string) => `binflip:listener:cursor:${address}`;
  let polling = false;

  const enqueue = (job: SignatureJob) =>
    signatures.add("sig", job, {
      jobId: jobId(job.address, job.signature),
      attempts: 8,
      backoff: { type: "exponential", delay: 1_000 },
      removeOnComplete: { age: 86_400, count: 10_000 },
      removeOnFail: { age: 7 * 86_400 },
    });

  // ── Leader registry ────────────────────────────────────────────────────
  const watcher = new LogsWatcher(
    config.SOLANA_WS_URL ?? wsUrlFromHttp(config.SOLANA_RPC_URL),
    log,
    (n) => {
      if (n.err) return;
      if (!n.logs.some((l) => METEORA_PROGRAMS.some((p) => l.includes(p)))) return;
      log.debug({ address: n.address, sig: n.signature }, "ws: meteora tx");
      void enqueue({ ...n, source: "ws", seenAt: Date.now() }).catch((err) => log.warn({ err }, "ws enqueue failed; polling will recover"));
    },
    () => void pollAll(), // recover anything missed while disconnected
  );

  async function refreshLeaders() {
    // Every address someone follows; paused leaders stay watched so their exits can be followed.
    const rows = await db
      .select({ address: schema.leaders.address, userId: schema.leaders.userId, leaderId: schema.leaders.id })
      .from(schema.leaders);
    const next = new Map<string, Array<{ userId: string; leaderId: string }>>();
    for (const r of rows) {
      const list = next.get(r.address) ?? [];
      list.push({ userId: r.userId, leaderId: r.leaderId });
      next.set(r.address, list);
    }
    const added = [...next.keys()].filter((a) => !followers.has(a));
    for (const a of added) {
      if (await connection.exists(cursorKey(a))) continue;
      // Start from "now": only positions opened after we start copying are copied.
      const [latest] = await rpc.getSignaturesForAddress(a, { limit: 1 });
      await connection.set(cursorKey(a), latest?.signature ?? "", "NX");
      log.info({ address: a }, "watching leader");
    }
    followers = next;
    watcher.setAddresses([...next.keys()]);
  }

  async function pollOne(address: string) {
    const until = await connection.get(cursorKey(address));
    const pages = [];
    let before: string | undefined;
    for (;;) {
      const page = await rpc.getSignaturesForAddress(address, { limit: 50, ...(until ? { until } : {}), ...(before ? { before } : {}) });
      if (!page.length) break;
      pages.push(page);
      if (page.length < 50) break;
      before = page.at(-1)!.signature;
    }
    const newest = pages[0]?.[0];
    if (!newest) return;
    for (const page of pages.reverse()) {
      for (const s of page.reverse()) {
        if (!s.err) await enqueue({ address, signature: s.signature, slot: s.slot, source: "poll", seenAt: Date.now() });
      }
    }
    await connection.set(cursorKey(address), newest.signature);
  }

  const enqueueExecution = (id: string) =>
    execution.add("plan", { leaderEventId: id }, { jobId: id, attempts: 5, backoff: { type: "exponential", delay: 1_000 } });

  async function pollAll() {
    if (polling) return;
    polling = true;
    try {
      for (const a of followers.keys()) {
        try {
          await pollOne(a);
        } catch (err) {
          log.warn({ address: a, err }, "poll failed");
        }
      }
      const pending = await db.select({ id: schema.leaderEvents.id }).from(schema.leaderEvents).where(isNull(schema.leaderEvents.processedAt));
      for (const event of pending) await enqueueExecution(event.id);
    } catch (err) {
      log.warn({ err }, "pending execution dispatch failed");
    } finally {
      polling = false;
    }
  }

  // ── Signature worker: fetch, decode, store ─────────────────────────────
  const worker = new Worker<SignatureJob>(
    QUEUES.LEADER_EVENTS,
    async (job) => {
      const { address, signature } = job.data;
      const tx = await rpc.getTransaction(signature);
      if (!tx) throw new Error("transaction not available yet"); // retried with backoff
      if (tx.meta?.err) return { skipped: "failed_tx" };

      const actions = extractActions(decodeMeteoraTx(tx)).filter((a) => a.owner === address);
      await flagTokenSells(tx, address, actions);
      if (!actions.length) return { actions: 0 };

      const latencyMs = tx.blockTime ? Date.now() - tx.blockTime * 1000 : null;
      let stored = 0;
      for (const f of followers.get(address) ?? []) {
        for (const a of actions) {
          const [row] = await db
            .insert(schema.leaderEvents)
            .values({
              userId: f.userId,
              leaderId: f.leaderId,
              protocol: a.protocol,
              signature,
              ixIndex: a.ixIndex,
              slot: BigInt(tx.slot),
              blockTime: tx.blockTime ? new Date(tx.blockTime * 1000) : null,
              instruction: a.instructions.join(","),
              pool: a.pool,
              leaderPosition: a.position,
              payload: { ...JSON.parse(JSON.stringify(a, bigintToString)), source: job.data.source },
            })
            .onConflictDoNothing()
            .returning({ id: schema.leaderEvents.id });
          if (!row) {
            const [pending] = await db.select({ id: schema.leaderEvents.id }).from(schema.leaderEvents).where(and(
              eq(schema.leaderEvents.userId, f.userId), eq(schema.leaderEvents.signature, signature),
              eq(schema.leaderEvents.ixIndex, a.ixIndex), isNull(schema.leaderEvents.processedAt),
            ));
            if (pending) await enqueueExecution(pending.id);
            continue;
          }
          stored++;
          await enqueueExecution(row.id);
          log.info(
            { leader: address.slice(0, 6), kind: a.kind, position: a.position, pool: a.pool, latencyMs, source: job.data.source, sig: signature },
            `leader ${a.kind}`,
          );
        }
      }
      return { actions: actions.length, stored };
    },
    { connection, concurrency: 4 },
  );
  worker.on("failed", (job, err) =>
    log.warn({ sig: job?.data.signature, attempts: job?.attemptsMade, err: err.message }, "signature job failed"),
  );

  // ── Start ──────────────────────────────────────────────────────────────
  await ping();
  await refreshLeaders();
  watcher.start();
  void pollAll();
  const t1 = setInterval(() => void refreshLeaders().catch((e) => log.error({ err: e }, "leader refresh failed")), REFRESH_LEADERS_MS);
  const t2 = setInterval(() => void pollAll(), config.LISTENER_POLL_MS);

  return {
    checks: {
      postgres: ping,
      redis: async () => void (await connection.ping()),
      websocket: async () => {
        if (!watcher.connected) throw new Error("disconnected");
      },
    },
    cleanups: [
      () => close(),
      async () => void (await connection.quit()),
      () => signatures.close(),
      () => execution.close(),
      () => worker.close(),
      () => watcher.close(),
      () => {
        clearInterval(t1);
        clearInterval(t2);
      },
    ],
  };
});

/**
 * Smart Token Retention "sells right away if this wallet sells the token": any
 * drop in the leader's balance of a mint that is not an LP add of that mint is
 * treated as a sell and flagged in Redis for 10 minutes.
 */
async function flagTokenSells(tx: RawTransaction, address: string, actions: LeaderAction[]) {
  const pre = new Map<string, bigint>();
  const post = new Map<string, bigint>();
  for (const b of tx.meta?.preTokenBalances ?? []) if (b.owner === address) pre.set(b.mint, (pre.get(b.mint) ?? 0n) + BigInt(b.uiTokenAmount.amount));
  for (const b of tx.meta?.postTokenBalances ?? []) if (b.owner === address) post.set(b.mint, (post.get(b.mint) ?? 0n) + BigInt(b.uiTokenAmount.amount));
  const deposited = new Set(actions.filter((a) => a.kind === "open" || a.kind === "add" || a.kind === "rebalance").flatMap((a) => [a.mintX, a.mintY]));
  for (const [mint, before] of pre) {
    if (mint === WSOL_MINT || deposited.has(mint)) continue;
    if ((post.get(mint) ?? 0n) < before) await sellFlags.set(leaderSoldKey(address, mint), String(Date.now()), "EX", 600);
  }
}

function bigintToString(_k: string, v: unknown) {
  return typeof v === "bigint" ? v.toString() : v;
}
