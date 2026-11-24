import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { PublicKey } from "@solana/web3.js";
import {
  DlmmTxBuilder,
  KeystoreSigner,
  LAMPORTS_PER_SOL,
  QUEUES,
  TxSender,
  createConnection,
  planCopy,
  readPassphraseFile,
  runService,
  WSOL_MINT,
  DammTxBuilder,
  type DammPoolInfo,
  JupiterClient,
  TokenInfoClient,
  checkTokenFilters,
  compoundRanges,
  type BuiltTxs,
  type Config,
  type ExecutionJob,
  type PoolInfo,
  type ManagementJob,
  type LeaderAction,
  type Logger,
  type NotificationJob,
  type Plan,
  type Strategy,
} from "@binflip/core";
import { createDb, schema, type Db } from "@binflip/db";
import { startSwapBack } from "./swapback.js";
import { startAccount } from "./account.js";
import { startManualOpen } from "./manualOpen.js";
import { startManagement } from "./management.js";

type PositionRow = typeof schema.positions.$inferSelect;
type EventRow = typeof schema.leaderEvents.$inferSelect;

interface Live {
  builder: DlmmTxBuilder;
  damm: DammTxBuilder;
  sender: TxSender;
  agentWalletId: string;
  publicKey: string;
  swapback?: ReturnType<typeof startSwapBack>;
  managementQueue?: Queue<ManagementJob>;
}

/**
 * executor — turns stored leader events into our actions.
 *
 * Every event gets exactly one txs row (idempotency key event_<id>):
 *   dry-run: planned (and the position mirror is updated right away)
 *   live:    planned → submitted (signature stored BEFORE broadcast) → confirmed | failed
 * A job that finds its row already "submitted" never re-sends: it marks the
 * row for review, so a crash can't double-spend.
 */
await runService("executor", async ({ config, log }) => {
  const { db, ping, close } = createDb(config.DATABASE_URL, { max: 5 });
  const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  const notifications = new Queue<NotificationJob>(QUEUES.NOTIFICATIONS, { connection });
  const live = config.mode === "live" ? await setupLive(db, config, log) : null;
  // Leader events and management decisions touch the same positions and balances: run them one at a time.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T,>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn);
    chain = run.catch(() => undefined);
    return run;
  };
  let management: ReturnType<typeof startManagement> | null = null;
  let account: ReturnType<typeof startAccount> | null = null;
  if (live) {
    live.managementQueue = new Queue<ManagementJob>(QUEUES.MANAGEMENT, { connection });
    live.swapback = startSwapBack({ db, connection, builder: live.builder, sender: live.sender, publicKey: live.publicKey, config, log, notifications });
    management = startManagement({ db, connection, builder: live.builder, damm: live.damm, sender: live.sender, swapback: live.swapback, config, log, notifications, serial });
    account = startAccount({ db, connection, sender: live.sender, publicKey: live.publicKey, config, log, notifications, serial });
  }

  // Positions we open on request (panel / Telegram): dry-run and live.
  const manualOpen = startManualOpen({
    db,
    connection,
    config,
    log,
    notifications,
    live,
    serial,
    zapBuyMint: (mint, lamports, onSignature) => zapBuyMint(live!, mint, lamports, config, onSignature),
  });

  const worker = new Worker<ExecutionJob>(
    QUEUES.EXECUTION,
    async (job) => {
      const r = await serial(() => handleEvent(db, job.data.leaderEventId, config, live, log));
      if (!r) return { duplicate: true };
      log.info({ leader: r.leaderLabel, kind: r.kind, outcome: r.outcome }, r.text);
      const kind =
        r.outcome === "skipped" ? "copy_skip" : r.outcome === "failed" || r.outcome === "needs_review" ? "copy_fail" : r.kind === "open" || r.kind === "add" ? "copy_open" : r.kind === "remove" || r.kind === "close" ? "copy_close" : "manage";
      await notifications.add("notify", { userId: r.userId, text: r.text, kind }, { removeOnComplete: 1000 });
      return { outcome: r.outcome };
    },
    // Serial: positions, balances and daily limits must not race.
    { connection, concurrency: 1 },
  );
  worker.on("failed", (job, err) => log.error({ event: job?.data.leaderEventId, err: err.message }, "event failed"));

  await ping();
  return {
    checks: {
      postgres: ping,
      redis: async () => void (await connection.ping()),
      ...(live ? { rpc: async () => void (await live.builder.connection.getSlot()) } : {}),
    },
    cleanups: [
      () => close(),
      async () => void (await connection.quit()),
      () => notifications.close(),
      () => worker.close(),
      ...(live?.swapback ? [() => live.swapback!.close()] : []),
      ...(management ? [() => management!.close()] : []),
      ...(account ? [() => account!.close()] : []),
      () => manualOpen.close(),
    ],
  };
});

async function setupLive(db: Db, config: Config, log: Logger): Promise<Live> {
  // Only the executor holds the key; the other services run "live" without it (they only read and queue).
  if (!config.KEYSTORE_PATH || !config.KEYSTORE_PASSPHRASE_FILE) throw new Error("Live executor requires KEYSTORE_PATH and KEYSTORE_PASSPHRASE_FILE");
  const signer = KeystoreSigner.fromFile(config.KEYSTORE_PATH!, readPassphraseFile(config.KEYSTORE_PASSPHRASE_FILE!));
  const [wallet] = await db.select().from(schema.agentWallets).where(eq(schema.agentWallets.publicKey, signer.publicKey));
  if (!wallet) throw new Error(`agent wallet ${signer.publicKey} is not registered (run wallet:create)`);
  const conn = createConnection(config.SOLANA_RPC_URL, config.SOLANA_WS_URL);
  const balance = await conn.getBalance(new PublicKey(signer.publicKey));
  log.warn({ agent: signer.publicKey, balanceSol: balance / 1e9 }, "LIVE: agent wallet loaded");
  return {
    builder: new DlmmTxBuilder(conn, new PublicKey(signer.publicKey)),
    damm: new DammTxBuilder(conn, new PublicKey(signer.publicKey)),
    sender: new TxSender(conn, signer),
    agentWalletId: wallet.id,
    publicKey: signer.publicKey,
  };
}

async function handleEvent(db: Db, eventId: string, config: Config, live: Live | null, log: Logger) {
  const [row] = await db
    .select()
    .from(schema.leaderEvents)
    .innerJoin(schema.leaders, eq(schema.leaders.id, schema.leaderEvents.leaderId))
    .innerJoin(schema.copySettings, eq(schema.copySettings.leaderId, schema.leaders.id))
    .where(eq(schema.leaderEvents.id, eventId));
  if (!row) throw new Error(`leader event ${eventId} or its copy settings not found`);
  const { leader_events: ev, leaders: leader, copy_settings: cs } = row;
  const idempotencyKey = `event_${ev.id}`;

  // A previous attempt already got this far: never act twice.
  const [existing] = await db
    .select()
    .from(schema.txs)
    .where(and(eq(schema.txs.userId, ev.userId), eq(schema.txs.idempotencyKey, idempotencyKey)));
  if (existing) {
    if (existing.status === "submitted" || (existing.status === "planned" && !existing.dryRun)) {
      await db
        .update(schema.txs)
        .set({ status: "failed", reason: "interrupted_needs_review" })
        .where(eq(schema.txs.id, existing.id));
      return {
        userId: ev.userId,
        leaderLabel: leader.label,
        kind: existing.kind,
        outcome: "needs_review",
        text: `⚠️ ${leader.label}: önceki deneme yarıda kaldı (${existing.kind}). Tekrar gönderilmedi, elle kontrol edin. İmzalar: ${JSON.stringify((existing.plan as any).signatures ?? [])}`,
      };
    }
    return null;
  }

  const risk = await getRisk(db, ev.userId);
  const action = toAction(ev.payload);
  const ours = ev.leaderPosition
    ? ((
        await db
          .select()
          .from(schema.positions)
          // Only copies made in the current mode: after going live, positions mirrored during dry-run
          // were never opened on chain and must not be removed/closed live (they count as not copied).
          .where(and(eq(schema.positions.userId, ev.userId), eq(schema.positions.leaderPosition, ev.leaderPosition), eq(schema.positions.dryRun, config.mode !== "live")))
      )[0] ?? null)
    : null;

  // Pool price (both modes, read-only): value-based Meme Protection, zap sizing and token filters.
  const entering = action.pool && (action.kind === "open" || action.kind === "add");
  const pool = action.protocol === "dlmm" && entering ? await poolInfoSafe(config, action.pool!, log) : null;
  const dammPool = action.protocol === "damm_v2" && entering ? await dammInfoSafe(config, action.pool!, log) : null;
  // DLMM price = raw Y per raw X at the active bin; we want lamports per raw token.
  const binPx = pool ? Math.pow(1 + pool.binStep / 10_000, pool.activeBinId) : null;
  const tokenPriceLamports = pool && binPx !== null ? (pool.solIsY ? binPx : 1 / binPx) : (dammPool?.tokenPriceLamports ?? null);
  const tokenMintOfPool = pool ? (pool.solIsY ? pool.mintX : pool.mintY) : dammPool ? (dammPool.solIsA ? dammPool.mintB : dammPool.mintA) : null;

  // DAMM V2 partial remove → the same share of ours: removed / (left + removed) of the leader's liquidity.
  if (action.protocol === "damm_v2" && action.kind === "remove" && action.liquidityDelta && action.position) {
    const left = await dammReader(config).unlockedLiquidity(action.position).catch(() => 0n);
    const bps = Number((action.liquidityDelta * 10_000n) / (left + action.liquidityDelta));
    action.removeRanges = [{ minBinId: null, maxBinId: null, bps: Math.max(1, Math.min(10_000, bps)) }];
  }

  let plan = planCopy(
    action,
    {
      tokenPriceLamports,
      heldTokens: live?.swapback && cs.smartTokenRetention && pool ? await live.swapback.heldAmount(ev.userId, pool.solIsY ? pool.mintX : pool.mintY) : 0n,
      sizing: {
        mode: cs.sizingMode,
        percentBps: cs.sizingPercentBps,
        fixedSol: cs.sizingFixedSol,
        maxPerAdd: cs.maxSolPerAdd,
        maxPerPosition: cs.maxSolPerPosition,
      },
      copyDlmmStrategies: cs.copyDlmmStrategies as Strategy[],
      copyDammV2: cs.copyDammV2,
      memeProtection: cs.memeProtection,
      leaderPaused: leader.status === "paused",
      followExitsWhilePaused: cs.followExitsWhilePaused,
      killSwitch: risk.killSwitch,
      fundProtectionTripped: risk.fundProtectionTrippedAt !== null,
      maxSolPerTx: risk.maxSolPerTx,
      dailyRoom: risk.maxSolPerDay - (await solSpentToday(db, ev.userId, config.mode !== "live")),
    },
    ours && {
      id: ours.id,
      state: ours.state,
      depositedSol: ours.depositedSol,
      ratioPpm: ours.sizeRatioPpm,
      fundedAt: ours.fundedAt,
      lowerBinId: ours.lowerBinId,
      upperBinId: ours.upperBinId,
    },
  );

  // LP Agent Security filters: checked before a position is opened.
  if (plan.do === "open" && tokenMintOfPool) {
    const mint = tokenMintOfPool;
    try {
      const info = await tokenInfo.get(mint);
      const f = checkTokenFilters(info, {
        minOrganicScore: risk.minOrganicScore,
        minMarketCapUsd: cs.minMarketCapUsd ?? risk.minMarketCapUsd,
        min24hVolumeUsd: risk.min24hVolumeUsd,
        minHolders: risk.minHolders,
        minTokenAgeHours: cs.minTokenAgeHours,
        blacklist: risk.tokenBlacklist,
      });
      if (!f.ok) {
        plan = { do: "skip", kind: action.kind, reason: f.reason };
        log.info({ mint, detail: f.detail }, "token filter");
      }
    } catch (err) {
      // Token data unavailable: retry the event rather than copy blind or drop it.
      throw new Error(`token data unavailable for ${mint}: ${(err as Error).message}`);
    }
  }

  // Live-only guards that need chain state.
  if (live && plan.do !== "skip") {
    // DAMM V2 empty opens have no account yet: the first funding add creates it.
    const dammFirstFunding = action.protocol === "damm_v2" && plan.do === "add" && ours && !ours.ourPosition;
    if (plan.do !== "open" && !ours?.ourPosition && !dammFirstFunding) plan = { do: "skip", kind: action.kind, reason: "position_not_copied" };
    // Every open pays position rent, even an empty one, so it needs the reserve too.
    else if (plan.do === "open" || (plan.do === "add" && plan.amountSol > 0n)) {
      const bal = BigInt(await live.builder.connection.getBalance(new PublicKey(live.publicKey)));
      if (bal < plan.amountSol + BigInt(config.SOL_RESERVE_LAMPORTS)) {
        plan = { do: "skip", kind: action.kind, reason: "low_balance" };
      }
    }
  }

  const dryRun = config.mode === "dry_run";
  const [t] = await db
    .insert(schema.txs)
    .values({
      userId: ev.userId,
      positionId: ours?.id ?? null,
      leaderEventId: ev.id,
      idempotencyKey,
      kind: plan.do === "skip" ? action.kind : plan.do,
      status: plan.do === "skip" ? "skipped" : "planned",
      reason: plan.do === "skip" ? plan.reason : null,
      dryRun,
      solDelta: "amountSol" in plan ? -plan.amountSol : null,
      plan: jsonSafe({ plan, action: { kind: action.kind, strategy: action.strategy, bins: [action.lowerBinId, action.upperBinId] } }),
    })
    .onConflictDoNothing()
    .returning({ id: schema.txs.id });
  if (!t) return null;
  await db.update(schema.leaderEvents).set({ processedAt: new Date() }).where(eq(schema.leaderEvents.id, ev.id));

  const base = { userId: ev.userId, leaderLabel: leader.label, kind: action.kind };
  if (plan.do === "skip") {
    const paused = plan.reason === "low_balance" ? await autoPauseIfDry(db, ev.userId) : 0;
    const extra = paused ? `\n⏸ Bot cüzdanı fonsuz: kopyalar art arda açılamadı, ${paused} cüzdan otomatik duraklatıldı. Bakiye yükleyip panelden tekrar açın.` : "";
    return { ...base, outcome: "skipped", text: describe(leader.label, action, plan, dryRun) + extra };
  }

  if (dryRun) {
    await applyToPositions(db, plan, action, ev, cs.managementMode, ours, true, t.id, null, undefined, exitRulesOf(cs));
    const str = (plan.do === "remove" || plan.do === "close") && cs.smartTokenRetention && action.protocol === "dlmm" ? ` (Smart Token Retention: token önce ${cs.strHoldSeconds} sn tutulurdu)` : "";
    return { ...base, outcome: "planned", text: describe(leader.label, action, plan, true) + str };
  }

  // ── LIVE ──────────────────────────────────────────────────────────────
  const l = live!;
  const signatures: string[] = [];
  const saveSig = async (sig: string) => {
    signatures.push(sig);
    await db
      .update(schema.txs)
      .set({ status: "submitted", signature: sig, attempts: sql`${schema.txs.attempts} + 1`, plan: sql`jsonb_set(${schema.txs.plan}, '{signatures}', ${JSON.stringify(signatures)}::jsonb)` })
      .where(eq(schema.txs.id, t.id));
  };
  const progress: { position: string | null } = { position: null };
  try {
    const tokenMint = action.mintY === WSOL_MINT ? action.mintX : action.mintX === WSOL_MINT ? action.mintY : null;
    const exits = plan.do === "remove" || plan.do === "close";
    const before = exits && tokenMint ? await l.builder.tokenBalance(tokenMint) : 0n;
    const { position: ourPosition, leftoverToken } = await executeLive(l, plan, action, ours, saveSig, config, log, ev.userId, progress);
    const fees = await totalFees(l, signatures);
    await db
      .update(schema.txs)
      .set({ status: "confirmed", feeLamports: BigInt(fees) })
      .where(eq(schema.txs.id, t.id));
    await applyToPositions(db, plan, action, ev, cs.managementMode, ours, false, t.id, ourPosition, l.agentWalletId, exitRulesOf(cs));
    if (ours && (plan.do === "claim" || plan.do === "close") && ours.unclaimedFeeSol && Number(ours.unclaimedFeeSol) > 0) {
      // Portfolio "Fee Earned": the fees this claim/close took out (last value the manager read).
      await db
        .update(schema.positions)
        .set({ claimedFeeSol: sql`${schema.positions.claimedFeeSol} + ${ours.unclaimedFeeSol}::numeric`, unclaimedFeeSol: "0" })
        .where(eq(schema.positions.id, ours.id));
    }
    if (plan.do === "open" && plan.empty) {
      // LP Agent: if the leader's funding add never comes, close the empty copy after ~1 min and get the rent back.
      const [p] = await db.select({ id: schema.positions.id }).from(schema.positions).where(and(eq(schema.positions.userId, ev.userId), eq(schema.positions.leaderPosition, action.position), eq(schema.positions.dryRun, false)));
      if (p) await l.managementQueue!.add("manage", { positionId: p.id, kind: "close_empty", reason: "unfunded_empty", activeId: 0 }, { jobId: `mgmt_${p.id}_close_empty`, delay: 60_000, attempts: 3, backoff: { type: "exponential", delay: 10_000 } });
    }
    // Like LP Agent: whatever token this exit produced is sold back to SOL (retried until sold).
    const after: string[] = [];
    if (plan.do === "rebalance" && leftoverToken && leftoverToken > 0n && tokenMint && action.pool) {
      // The leader's new range has no bins above price: sell the token, like any exit.
      await l.swapback!.enqueue({ userId: ev.userId, key: ev.id, leaderEventId: ev.id, positionId: ours?.id ?? null, mint: tokenMint, pool: action.pool, amount: leftoverToken.toString(), label: leader.label });
      after.push("🔁 Yeni aralıkta fiyatın üstü yok: token SOL'e çevrilmek üzere kuyrukta.");
    }
    if (exits && tokenMint && action.pool) {
      const received = (await l.builder.tokenBalance(tokenMint)) - before;
      if (received > 0n) {
        // Smart Token Retention (DLMM): keep the token for the hold time; a re-add reuses it.
        const retain = cs.smartTokenRetention && action.protocol === "dlmm";
        const info = retain ? await l.builder.poolInfo(action.pool).catch(() => null) : null;
        const px = info ? Math.pow(1 + info.binStep / 10_000, info.activeBinId) : null;
        const hold =
          retain && info && px !== null
            ? {
                untilMs: Date.now() + cs.strHoldSeconds * 1000,
                startPriceLamports: info.solIsY ? px : 1 / px,
                sellOnDropBps: cs.strSellOnDropBps,
                sellOnLeaderSell: cs.strSellOnLeaderSell,
                leaderId: leader.id,
                leaderAddress: leader.address,
              }
            : undefined;
        await l.swapback!.enqueue({ userId: ev.userId, key: ev.id, leaderEventId: ev.id, positionId: ours?.id ?? null, mint: tokenMint, pool: action.pool, amount: received.toString(), label: leader.label, ...(hold ? { hold } : {}) });
        after.push(hold ? `⏳ Token ${cs.strHoldSeconds} sn tutuluyor (Smart Token Retention); lider geri eklerse yeniden kullanılacak, eklemezse satılacak.` : "🔁 Çıkan token SOL'e çevrilmek üzere kuyruğa alındı.");
      } else if (plan.do === "close") {
        await l.swapback!.sweepAfterClose({ userId: ev.userId, key: ev.id, leaderEventId: ev.id, positionId: ours?.id ?? null, txId: "", mint: tokenMint, pool: action.pool, amount: "0", label: leader.label });
      }
    }
    return {
      ...base,
      outcome: "confirmed",
      text: [`${describe(leader.label, action, plan, false)} ✅ ${signatures.length} işlem, ücret ${sol(BigInt(fees))} SOL`, ...after].join("\n"),
    };
  } catch (err) {
    const msg = (err as Error).message;
    await db
      .update(schema.txs)
      .set({ status: "failed", error: msg.slice(0, 2000), reason: signatures.length ? "partial_needs_review" : "send_failed" })
      .where(eq(schema.txs.id, t.id));
    log.error({ err: msg, signatures }, "live execution failed");
    // An open that failed after its position was created on chain (e.g. the funding add failed):
    // record the copy anyway, so it is managed and still follows the leader's exit instead of
    // sitting untracked in the wallet. Never re-sent automatically.
    if (plan.do === "open" && progress.position && !ours) {
      await applyToPositions(db, plan, action, ev, cs.managementMode, null, false, t.id, progress.position, l.agentWalletId, exitRulesOf(cs)).catch((e) =>
        log.error({ err: (e as Error).message }, "could not record the partially opened position"),
      );
    }
    return {
      ...base,
      outcome: "failed",
      text: `❌ ${leader.label}: ${plan.do} başarısız: ${msg.slice(0, 200)}${signatures.length ? ` (gönderilen: ${signatures.length} işlem, kontrol edin)` : ""}`,
    };
  }
}

/** Build and send the plan. Returns our position address (for opens). */
async function executeLive(
  l: Live,
  plan: Plan,
  a: LeaderAction,
  ours: PositionRow | null,
  onSignature: (sig: string) => Promise<void>,
  config: Config,
  log: Logger,
  userId: string,
  progress: { position: string | null } = { position: null },
): Promise<{ position: string | null; leftoverToken?: bigint }> {
  const res = await executeLiveInner(l, plan, a, ours, onSignature, config, log, userId, progress);
  return typeof res === "object" && res !== null ? res : { position: res };
}

async function executeLiveInner(
  l: Live,
  plan: Plan,
  a: LeaderAction,
  ours: PositionRow | null,
  onSignature: (sig: string) => Promise<void>,
  config: Config,
  log: Logger,
  userId: string,
  progress: { position: string | null } = { position: null },
): Promise<string | null | { position: string | null; leftoverToken?: bigint }> {
  const opts = { priorityMicroLamports: config.PRIORITY_FEE_MICROLAMPORTS, onSignature };
  const sendAll = async (built: BuiltTxs) => {
    for (const [i, tx] of built.txs.entries()) {
      const r = await l.sender.send(tx, built.extraSigners.get(i) ?? [], opts);
      log.info({ sig: r.signature, step: `${i + 1}/${built.txs.length}`, fee: r.feeLamports }, "confirmed");
      // The first confirmed tx of an open creates the position account: remember it (see the catch above).
      if (i === 0 && built.position) progress.position ??= built.position;
    }
    return built.position;
  };
  const pool = a.pool!;
  if (a.protocol === "damm_v2") return executeDamm(l, plan, a, ours, onSignature, config, sendAll);
  const slippagePct = 1;

  switch (plan.do) {
    case "open": {
      if (a.lowerBinId === null || a.upperBinId === null) throw new Error("leader range unknown");
      if (plan.swapSol && plan.swapSol > 0n) {
        // Zap: empty position on the leader's range, then a two-sided add in the leader's ratio.
        const created = await l.builder.open({ pool, lowerBinId: a.lowerBinId, upperBinId: a.upperBinId, amountSol: 0n, strategy: a.strategy, slippagePct });
        const position = (await sendAll(created))!;
        const tokens = await zapBuy(l, pool, plan.swapSol, config, onSignature);
        await sendAll(await l.builder.addTwoSided({ pool, position, lowerBinId: a.lowerBinId, upperBinId: a.upperBinId, amountSol: plan.amountSol - plan.swapSol, amountToken: tokens, strategy: a.strategy, slippagePct }));
        return position;
      }
      const built = await l.builder.open({
        pool,
        lowerBinId: a.lowerBinId,
        upperBinId: a.upperBinId,
        amountSol: plan.amountSol,
        strategy: a.strategy,
        slippagePct,
      });
      const position = await sendAll(built);
      // Wide or empty opens create the position first; fund it now if needed.
      const width = a.upperBinId - a.lowerBinId + 1;
      if (plan.amountSol > 0n && (width > 70 || built.txs.length === 1) && !(await hasLiquidity(l, pool, position!))) {
        await sendAll(
          await l.builder.add({ pool, position: position!, lowerBinId: a.lowerBinId, upperBinId: a.upperBinId, amountSol: plan.amountSol, strategy: a.strategy, slippagePct }),
        );
      }
      return position;
    }
    case "add":
      if ((plan.tokenFromHold ?? 0n) > 0n || (plan.swapSol ?? 0n) > 0n) {
        // Smart Token Retention: put the kept token back first; zap only for what is still missing.
        const info = await l.builder.poolInfo(pool);
        const kept = plan.tokenFromHold ? await l.swapback!.takeHeld(userId, info.solIsY ? info.mintX : info.mintY, plan.tokenFromHold) : 0n;
        const bought = plan.swapSol && plan.swapSol > 0n ? await zapBuy(l, pool, plan.swapSol, config, onSignature) : 0n;
        const tokens = kept + bought;
        return sendAll(
          await l.builder.addTwoSided({
            pool,
            position: ours!.ourPosition!,
            lowerBinId: a.lowerBinId ?? ours!.lowerBinId!,
            upperBinId: a.upperBinId ?? ours!.upperBinId!,
            amountSol: plan.amountSol - (plan.swapSol ?? 0n),
            amountToken: tokens,
            strategy: a.strategy ?? ours!.strategy,
            slippagePct,
          }),
        );
      }
      return sendAll(
        await l.builder.add({
          pool,
          position: ours!.ourPosition!,
          lowerBinId: ours!.lowerBinId ?? a.lowerBinId!,
          upperBinId: ours!.upperBinId ?? a.upperBinId!,
          amountSol: plan.amountSol,
          strategy: a.strategy ?? ours!.strategy,
          slippagePct,
        }),
      );
    case "remove":
      return sendAll(await l.builder.remove({ pool, position: ours!.ourPosition!, bps: plan.bps, close: false }));
    case "close":
      return sendAll(await l.builder.remove({ pool, position: ours!.ourPosition!, bps: 10_000, close: true }));
    case "claim":
      return sendAll(await l.builder.claim({ pool, position: ours!.ourPosition! }));
    case "rebalance": {
      // Mirror a full move (see core/meteora/rebalance.ts): read what we hold, close, reopen on the new range.
      const r = a.rebalance!;
      const before = await l.builder.positionBins(pool, ours!.ourPosition!);
      const ourY = BigInt(Math.floor(before.bins.reduce((s, b) => s + b.y, 0)));
      const ourX = BigInt(Math.floor(before.bins.reduce((s, b) => s + b.x, 0)));
      await sendAll(await l.builder.remove({ pool, position: ours!.ourPosition!, bps: 10_000, close: true }));
      const opened = await l.builder.open({ pool, lowerBinId: r.newMin, upperBinId: r.newMax, amountSol: ourY, strategy: a.strategy, slippagePct });
      const position = (await sendAll(opened))!;
      if (ourY > 0n && !(await hasLiquidity(l, pool, position))) {
        await sendAll(await l.builder.add({ pool, position, lowerBinId: r.newMin, upperBinId: r.newMax, amountSol: ourY, strategy: a.strategy, slippagePct }));
      }
      const info = await l.builder.poolInfo(pool);
      const above = compoundRanges(r.newMin, r.newMax, info.activeBinId).token;
      if (ourX > 0n && above) {
        await sendAll(await l.builder.addToken({ pool, position, fromBinId: above.from, toBinId: above.to, amount: ourX, strategy: a.strategy, slippagePct }));
        return { position };
      }
      return { position, leftoverToken: ourX };
    }
    case "skip":
      return null;
  }
}

async function hasLiquidity(l: Live, pool: string, position: string) {
  const p = await l.builder.position(pool, position);
  return p.positionData.positionBinData.some((b) => b.positionLiquidity !== "0");
}

async function totalFees(l: Live, sigs: string[]): Promise<number> {
  let fee = 0;
  for (const s of sigs) {
    const t = await l.builder.connection
      .getTransaction(s, { commitment: "confirmed", maxSupportedTransactionVersion: 1 as 0 })
      .catch(() => null);
    fee += t?.meta?.fee ?? 0;
  }
  return fee;
}

/** Mirror the plan onto our positions table. Live: only after confirmation. */
async function applyToPositions(
  db: Db,
  plan: Plan,
  a: LeaderAction,
  ev: EventRow,
  mgmt: (typeof schema.managementMode.enumValues)[number],
  ours: PositionRow | null,
  dryRun: boolean,
  txId: string,
  ourPosition: string | null,
  agentWalletId?: string,
  exitRules?: { takeProfitBps: number | null; stopLossBps: number | null; trailingStopBps: number | null },
) {
  const now = new Date();
  if (plan.do === "open") {
    const [p] = await db
      .insert(schema.positions)
      .values({
        userId: ev.userId,
        leaderId: ev.leaderId,
        agentWalletId: agentWalletId ?? null,
        protocol: a.protocol,
        pool: a.pool ?? "unknown",
        leaderPosition: a.position,
        ourPosition,
        state: plan.empty ? "OPENING" : "ACTIVE",
        dryRun,
        strategy: a.strategy,
        managementMode: mgmt,
        lowerBinId: a.lowerBinId,
        upperBinId: a.upperBinId,
        entryActiveBinId: a.activeBinId,
        sizeRatioPpm: plan.ratioPpm,
        depositedSol: plan.amountSol,
        fundedAt: plan.empty ? null : now,
        openedAt: now,
        // LP Agent: exit rules are saved on the copy when it opens.
        ...(exitRules ? { ...exitRules, exitRulesSaved: true } : {}),
      })
      .onConflictDoNothing()
      .returning({ id: schema.positions.id });
    if (p) await db.update(schema.txs).set({ positionId: p.id }).where(eq(schema.txs.id, txId));
    return;
  }
  if (!ours) return;
  if (plan.do === "add") {
    await db
      .update(schema.positions)
      .set({
        state: "ACTIVE",
        depositedSol: sql`${schema.positions.depositedSol} + ${plan.amountSol}`,
        // DAMM V2: the first funding add is what creates our on-chain position.
        ...(ourPosition && !ours.ourPosition ? { ourPosition } : {}),
        ...(plan.firstFunding
          ? { sizeRatioPpm: plan.ratioPpm, fundedAt: now, strategy: a.strategy, entryActiveBinId: a.activeBinId }
          : {}),
        ...(dryRun && a.lowerBinId !== null ? { lowerBinId: a.lowerBinId, upperBinId: a.upperBinId } : {}),
      })
      .where(eq(schema.positions.id, ours.id));
  } else if (plan.do === "close") {
    await db
      .update(schema.positions)
      .set({ state: "CLOSED", closedAt: now, closeReason: "leader_exit" })
      .where(eq(schema.positions.id, ours.id));
  } else if (plan.do === "rebalance" && a.rebalance) {
    // New range (and, live, a new position account). Flip/entry references restart from here.
    await db
      .update(schema.positions)
      .set({
        lowerBinId: a.rebalance.newMin,
        upperBinId: a.rebalance.newMax,
        entryActiveBinId: a.activeBinId,
        lastFlipBinId: null,
        strategy: a.strategy ?? ours.strategy,
        ...(ourPosition ? { ourPosition } : {}),
        // Dry-run: rebuild the virtual model on the new range at the next manager tick.
        ...(dryRun ? { simState: null } : {}),
      })
      .where(eq(schema.positions.id, ours.id));
  }
}

async function getRisk(db: Db, userId: string) {
  const [r] = await db.select().from(schema.userRiskSettings).where(eq(schema.userRiskSettings.userId, userId));
  if (r) return r;
  await db.insert(schema.userRiskSettings).values({ userId }).onConflictDoNothing();
  return (await db.select().from(schema.userRiskSettings).where(eq(schema.userRiskSettings.userId, userId)))[0]!;
}

async function solSpentToday(db: Db, userId: string, dryRun: boolean): Promise<bigint> {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const [r] = await db
    .select({ spent: sql<string>`coalesce(sum(-${schema.txs.solDelta}), 0)` })
    .from(schema.txs)
    .where(
      and(
        eq(schema.txs.userId, userId),
        gte(schema.txs.createdAt, start),
        // Only this mode's spending: dry-run "would do" amounts must not use up the live day's limit.
        eq(schema.txs.dryRun, dryRun),
        inArray(schema.txs.kind, ["open", "add"]),
        inArray(schema.txs.status, ["planned", "simulated", "submitted", "confirmed"]),
      ),
    );
  return BigInt(r?.spent ?? "0");
}

/** Payload JSON (bigints as strings) → LeaderAction. */
function toAction(p: Record<string, unknown>): LeaderAction {
  const pair = (v: any) => ({ x: BigInt(v?.x ?? 0), y: BigInt(v?.y ?? 0) });
  const a = p as any;
  return {
    ...a,
    added: pair(a.added),
    removed: pair(a.removed),
    fees: pair(a.fees),
    removeRanges: a.removeRanges ?? [],
    ...(a.liquidityDelta !== undefined ? { liquidityDelta: BigInt(a.liquidityDelta) } : {}),
  };
}

function jsonSafe(v: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
}

function sol(lamports: bigint): string {
  const whole = lamports / LAMPORTS_PER_SOL;
  const frac = (lamports % LAMPORTS_PER_SOL).toString().padStart(9, "0").slice(0, 4);
  return `${whole}.${frac}`;
}

function describe(label: string, a: LeaderAction, plan: Plan, dryRun: boolean): string {
  const prefix = dryRun ? "[DENEME]" : "[CANLI]";
  const verb = (would: string, did: string) => (dryRun ? would : did);
  const where = `${a.protocol.toUpperCase()} ${a.pool?.slice(0, 6) ?? "?"}…`;
  const leaderSol = a.mintY?.startsWith("So111") ? a.added.y : a.added.x;
  const head = `${prefix} ${label}: ${a.kind}${a.strategy ? ` (${a.strategy})` : ""} ${where}`;
  switch (plan.do) {
    case "open":
      return plan.empty
        ? `${head} → boş pozisyon ${verb("açardım", "açıldı")} (lider fonlamayı ayrı işlemde yapıyor)`
        : `${head} → ${sol(plan.amountSol)} SOL ile ${verb("açardım", "açıldı")} (lider ${sol(leaderSol)} SOL)${plan.capped ? `, sınır: ${plan.capped}` : ""}`;
    case "add":
      return `${head} → ${sol(plan.amountSol)} SOL ${verb("eklerdim", "eklendi")} (lider ${sol(leaderSol)} SOL, oran %${(Number(plan.ratioPpm) / 10_000).toFixed(2)})${plan.capped ? `, sınır: ${plan.capped}` : ""}`;
    case "remove":
      return `${head} → pozisyonun %${plan.bps / 100}'i ${verb("çekilirdi, çıkan token SOL'e çevrilirdi", "çekildi")}`;
    case "close":
      return `${head} → pozisyon ${verb("kapatılırdı, kalan token aynı havuzda SOL'e çevrilirdi", "kapatıldı")}`;
    case "claim":
      return `${head} → fee ${verb("claim edilirdi", "claim edildi")}`;
    case "rebalance":
      return `${head} → kopya liderle aynı şekilde ${a.rebalance ? `${a.rebalance.oldMin}..${a.rebalance.oldMax} → ${a.rebalance.newMin}..${a.rebalance.newMax}` : ""} ${verb("taşınırdı", "taşındı")}`;
    case "skip":
      return `${head} → atlandı: ${plan.reason}`;
  }
}

function exitRulesOf(cs: { takeProfitBps: number | null; stopLossBps: number | null; trailingStopBps: number | null }) {
  return { takeProfitBps: cs.takeProfitBps, stopLossBps: cs.stopLossBps, trailingStopBps: cs.trailingStopBps };
}


/** LP Agent: copies that keep failing for lack of funds pause the user's wallets. */
const AUTO_PAUSE_AFTER = 3;
async function autoPauseIfDry(db: Db, userId: string): Promise<number> {
  const recent = await db
    .select({ reason: schema.txs.reason })
    .from(schema.txs)
    .where(and(eq(schema.txs.userId, userId), inArray(schema.txs.kind, ["open", "add"])))
    .orderBy(sql`${schema.txs.createdAt} desc`)
    .limit(AUTO_PAUSE_AFTER);
  if (recent.length < AUTO_PAUSE_AFTER || !recent.every((r) => r.reason === "low_balance")) return 0;
  const paused = await db
    .update(schema.leaders)
    .set({ status: "paused" })
    .where(and(eq(schema.leaders.userId, userId), eq(schema.leaders.status, "active")))
    .returning({ id: schema.leaders.id });
  return paused.length;
}

const tokenInfo = new TokenInfoClient();
const jupiter = new JupiterClient();
let reader: DlmmTxBuilder | null = null;

/** Read-only pool info for pricing; null (and logged) if the pool can't be read. */
async function poolInfoSafe(config: Config, pool: string, log: Logger): Promise<PoolInfo | null> {
  reader ??= new DlmmTxBuilder(createConnection(config.SOLANA_RPC_URL), PublicKey.default);
  try {
    return await reader.poolInfo(pool);
  } catch (err) {
    log.warn({ pool, err: (err as Error).message }, "pool read failed; pricing unavailable");
    return null;
  }
}

/** LP Agent zap: buy the token's share with SOL via Jupiter; returns the token amount received. */
async function zapBuy(l: Live, pool: string, lamports: bigint, config: Config, onSignature: (sig: string) => Promise<void>): Promise<bigint> {
  const info = await l.builder.poolInfo(pool);
  return zapBuyMint(l, info.solIsY ? info.mintX : info.mintY, lamports, config, onSignature);
}

async function zapBuyMint(l: Live, mint: string, lamports: bigint, config: Config, onSignature: (sig: string) => Promise<void>): Promise<bigint> {
  const before = await l.builder.tokenBalance(mint);
  const q = await jupiter.quoteFromSol(mint, lamports, 300);
  const { tx, lastValidBlockHeight } = await jupiter.buildSwap(q, l.publicKey, 2_000_000);
  await l.sender.sendVersioned(tx, lastValidBlockHeight, { priorityMicroLamports: config.PRIORITY_FEE_MICROLAMPORTS, onSignature });
  const received = (await l.builder.tokenBalance(mint)) - before;
  if (received <= 0n) throw new Error("zap swap returned no tokens");
  return received;
}

let dammR: DammTxBuilder | null = null;
const dammReader = (config: Config) => (dammR ??= new DammTxBuilder(createConnection(config.SOLANA_RPC_URL), PublicKey.default));

async function dammInfoSafe(config: Config, pool: string, log: Logger): Promise<DammPoolInfo | null> {
  try {
    return await dammReader(config).poolInfo(pool);
  } catch (err) {
    log.warn({ pool, err: (err as Error).message }, "damm pool read failed; pricing unavailable");
    return null;
  }
}

/**
 * DAMM V2 live copy (LP Agent copies every DAMM V2 position). DAMM V2 takes both
 * tokens at the pool price, so every deposit is a zap: buy the token's share with
 * SOL via Jupiter, then deposit both. An empty leader open has no account yet;
 * our position is created at the first funding add.
 */
async function executeDamm(
  l: Live,
  plan: Plan,
  a: LeaderAction,
  ours: PositionRow | null,
  onSignature: (sig: string) => Promise<void>,
  config: Config,
  sendAll: (b: BuiltTxs) => Promise<string | null>,
): Promise<string | null> {
  const pool = a.pool!;
  const info = await l.damm.poolInfo(pool);
  if (!info.solIsA && !info.solIsB) throw new Error("DAMM V2 pool has no SOL side");
  const mint = info.solIsA ? info.mintB : info.mintA;
  const split = async (sol: bigint, swap: bigint) => {
    const tokens = swap > 0n ? await zapBuyMint(l, mint, swap, config, onSignature) : 0n;
    const rest = sol - swap;
    return info.solIsA ? { amountA: rest, amountB: tokens } : { amountA: tokens, amountB: rest };
  };
  switch (plan.do) {
    case "open":
      if (plan.empty) return null; // created at the first funding add
      return sendAll(await l.damm.open({ pool, ...(await split(plan.amountSol, plan.swapSol ?? plan.amountSol / 2n)), slippageBps: 300 }));
    case "add":
      if (!ours?.ourPosition) return sendAll(await l.damm.open({ pool, ...(await split(plan.amountSol, plan.swapSol ?? plan.amountSol / 2n)), slippageBps: 300 }));
      return sendAll(await l.damm.add({ pool, position: ours.ourPosition, ...(await split(plan.amountSol, plan.swapSol ?? plan.amountSol / 2n)) }));
    case "remove":
      return sendAll(await l.damm.remove({ pool, position: ours!.ourPosition!, bps: plan.bps, close: false }));
    case "close":
      return sendAll(await l.damm.remove({ pool, position: ours!.ourPosition!, bps: 10_000, close: true }));
    case "claim":
      return sendAll(await l.damm.claim({ pool, position: ours!.ourPosition! }));
    default:
      return null;
  }
}
