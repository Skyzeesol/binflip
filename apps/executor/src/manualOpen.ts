import { Worker, type Queue } from "bullmq";
import type { Redis } from "ioredis";
import { PublicKey } from "@solana/web3.js";
import { and, eq } from "drizzle-orm";
import {
  QUEUES,
  WSOL_MINT,
  DlmmTxBuilder,
  DammTxBuilder,
  binsForRange,
  createConnection,
  type BuiltTxs,
  type Config,
  type Logger,
  type NotificationJob,
  type OpenJob,
  type TxSender,
} from "@binflip/core";
import { schema, type Db } from "@binflip/db";

export interface OpenLive {
  builder: DlmmTxBuilder;
  damm: DammTxBuilder;
  sender: TxSender;
  agentWalletId: string;
  publicKey: string;
}

/**
 * Opens a position in a pool we picked (panel "Create Position", Telegram wizard).
 * Dry-run: the position is recorded and simulated by the manager like a copy.
 * Live: opened from the agent wallet; a range above the price is funded by a
 * zap (part of the SOL bought as the token via Jupiter), like LP Agent's Zap In.
 */
export function startManualOpen(p: {
  db: Db;
  connection: Redis;
  config: Config;
  log: Logger;
  notifications: Queue<NotificationJob>;
  live: OpenLive | null;
  serial: <T>(fn: () => Promise<T>) => Promise<T>;
  zapBuyMint: (mint: string, lamports: bigint, onSignature: (sig: string) => Promise<void>) => Promise<bigint>;
}) {
  const { db, config, log } = p;
  const reader = p.live?.builder ?? new DlmmTxBuilder(createConnection(config.SOLANA_RPC_URL), PublicKey.default);
  const dammReader = p.live?.damm ?? new DammTxBuilder(createConnection(config.SOLANA_RPC_URL), PublicKey.default);
  const notify = (userId: string, text: string) => p.notifications.add("notify", { userId, text, kind: "manage" }, { removeOnComplete: 1000 });

  const worker = new Worker<OpenJob>(QUEUES.OPEN, (job) => p.serial(() => open(job.data)), { connection: p.connection, concurrency: 1 });
  worker.on("failed", async (job, err) => {
    if (!job) return;
    log.warn({ err: err.message, pool: job.data.pool }, "manual open failed");
    await notify(job.data.userId, `❌ Pozisyon açılamadı (${job.data.pool.slice(0, 6)}…): ${err.message.slice(0, 200)}`);
  });

  async function open(j: OpenJob) {
    const key = `open_${j.requestId}`;
    const [dup] = await db.select({ id: schema.txs.id }).from(schema.txs).where(and(eq(schema.txs.userId, j.userId), eq(schema.txs.idempotencyKey, key)));
    if (dup) return { duplicate: true };
    const [risk] = await db.select().from(schema.userRiskSettings).where(eq(schema.userRiskSettings.userId, j.userId));
    if (risk?.killSwitch) throw new Error("acil durdurma açık: yeni pozisyon açılmıyor");
    if (risk?.fundProtectionTrippedAt) throw new Error("zarar limiti doldu: yeni pozisyon açılmıyor");
    const lamports = BigInt(j.lamports);
    if (risk && lamports > risk.maxSolPerTx) throw new Error(`işlem başına sınır ${Number(risk.maxSolPerTx) / 1e9} SOL`);
    const dryRun = config.mode !== "live" || !p.live;
    // Settings → Auto TP/SL: applies when the request didn't set exits itself (the Telegram wizard doesn't ask).
    if (j.takeProfitBps === undefined && j.stopLossBps === undefined) {
      const [u] = await db.select({ prefs: schema.users.prefs }).from(schema.users).where(eq(schema.users.id, j.userId));
      const auto = (u?.prefs as { autoTpSl?: { enabled: boolean; takeProfitPct: number; stopLossPct: number } } | undefined)?.autoTpSl;
      if (auto?.enabled) {
        j.takeProfitBps = Math.round(auto.takeProfitPct * 100);
        j.stopLossBps = Math.round(auto.stopLossPct * 100);
      }
    }
    const label = j.origin === "telegram" ? "Telegram" : "Panel";

    // Pool geometry and the range in bins.
    let lower: number | null = null;
    let upper: number | null = null;
    let active: number | null = null;
    let binStep: number | null = null;
    let mintX: string;
    let mintY: string;
    let tokenShare = 0.5;
    if (j.protocol === "dlmm") {
      const info = await reader.poolInfo(j.pool);
      if (!info.solIsY && info.mintX !== WSOL_MINT) throw new Error("havuzda SOL yok");
      if (!info.solIsY) throw new Error("SOL'ün X tarafında olduğu havuzlar henüz desteklenmiyor");
      const r = binsForRange(info.activeBinId, info.binStep, j.lowerPct, j.upperPct);
      ({ lower, upper } = r);
      tokenShare = r.tokenShare;
      active = info.activeBinId;
      binStep = info.binStep;
      mintX = info.mintX;
      mintY = info.mintY;
    } else {
      const info = await dammReader.poolInfo(j.pool);
      if (!info.solIsA && !info.solIsB) throw new Error("havuzda SOL yok");
      mintX = info.mintA;
      mintY = info.mintB;
    }

    const base = {
      userId: j.userId,
      protocol: j.protocol,
      pool: j.pool,
      strategy: j.protocol === "dlmm" ? j.strategy : null,
      managementMode: j.managementMode,
      lowerBinId: lower,
      upperBinId: upper,
      entryActiveBinId: active,
      activeBinId: active,
      binStep,
      mintX,
      mintY,
      depositedSol: lamports,
      openedAt: new Date(),
      fundedAt: new Date(),
      origin: j.origin,
      feeMode: j.feeMode,
      compoundMinutes: j.feeMode === "hold" ? null : (j.compoundMinutes ?? 60),
      managementParams: j.flipThresholdBps ? { flipThresholdBps: j.flipThresholdBps } : null,
      takeProfitBps: j.takeProfitBps ?? null,
      stopLossBps: j.stopLossBps ?? null,
      trailingStopBps: j.trailingStopBps ?? null,
      exitRulesSaved: true,
    } as const;
    const where = j.protocol === "dlmm" ? `bin ${lower}..${upper} (${j.lowerPct}%..${j.upperPct}%), ${j.strategy}` : "DAMM V2";
    const fees = j.feeMode === "compound" ? "fee'ler compound" : j.feeMode === "sell" ? "fee'ler SOL'e satılır" : "fee'ler pozisyonda";

    if (dryRun) {
      const [pos] = await db.insert(schema.positions).values({ ...base, state: "ACTIVE", dryRun: true }).returning({ id: schema.positions.id });
      await db.insert(schema.txs).values({ userId: j.userId, positionId: pos!.id, idempotencyKey: key, kind: "open", status: "planned", reason: `manual_${j.origin}`, dryRun: true, solDelta: -lamports, plan: { ...j } as never });
      await notify(j.userId, `[DENEME] ${label}: ${(Number(lamports) / 1e9).toFixed(4)} SOL ile ${j.pool.slice(0, 6)}… açardım: ${where}; ${fees}.`);
      return { planned: true, positionId: pos!.id };
    }

    const l = p.live!;
    const bal = BigInt(await l.sender.connection.getBalance(new PublicKey(l.publicKey)));
    if (bal < lamports + BigInt(config.SOL_RESERVE_LAMPORTS)) throw new Error(`bakiye yetersiz: ${Number(bal) / 1e9} SOL (gereken ${Number(lamports + BigInt(config.SOL_RESERVE_LAMPORTS)) / 1e9})`);
    const [t] = await db
      .insert(schema.txs)
      .values({ userId: j.userId, idempotencyKey: key, kind: "open", status: "planned", reason: `manual_${j.origin}`, dryRun: false, solDelta: -lamports, plan: { ...j, signatures: [] } as never })
      .onConflictDoNothing()
      .returning();
    if (!t) return { duplicate: true };
    const sigs: string[] = [];
    const onSignature = async (sig: string) => {
      sigs.push(sig);
      await db.update(schema.txs).set({ status: "submitted", signature: sig, plan: { ...j, signatures: sigs } as never }).where(eq(schema.txs.id, t.id));
    };
    const sendAll = async (built: BuiltTxs) => {
      for (const [i, tx] of built.txs.entries()) await l.sender.send(tx, built.extraSigners.get(i) ?? [], { priorityMicroLamports: config.PRIORITY_FEE_MICROLAMPORTS, onSignature });
      return built.position ?? null;
    };

    let position: string | null;
    try {
      if (j.protocol === "damm_v2") {
        const info = await l.damm.poolInfo(j.pool);
        const mint = info.solIsA ? info.mintB : info.mintA;
        const swap = lamports / 2n;
        const tokens = await p.zapBuyMint(mint, swap, onSignature);
        const rest = lamports - swap;
        position = await sendAll(await l.damm.open({ pool: j.pool, ...(info.solIsA ? { amountA: rest, amountB: tokens } : { amountA: tokens, amountB: rest }), slippageBps: 300 }));
      } else if (tokenShare > 0) {
        // Zap In: buy the token share of the range, then add both sides.
        const swap = BigInt(Math.floor(Number(lamports) * tokenShare));
        const tokens = swap > 0n ? await p.zapBuyMint(mintX!, swap, onSignature) : 0n;
        const created = await l.builder.open({ pool: j.pool, lowerBinId: lower!, upperBinId: upper!, amountSol: 0n, strategy: j.strategy, slippagePct: 1 });
        position = await sendAll(created);
        await sendAll(await l.builder.addTwoSided({ pool: j.pool, position: position!, lowerBinId: lower!, upperBinId: upper!, amountSol: lamports - swap, amountToken: tokens, strategy: j.strategy, slippagePct: 1 }));
      } else {
        const built = await l.builder.open({ pool: j.pool, lowerBinId: lower!, upperBinId: upper!, amountSol: lamports, strategy: j.strategy, slippagePct: 1 });
        position = await sendAll(built);
        if (built.txs.length === 1 && upper! - lower! + 1 > 70) {
          await sendAll(await l.builder.add({ pool: j.pool, position: position!, lowerBinId: lower!, upperBinId: upper!, amountSol: lamports, strategy: j.strategy, slippagePct: 1 }));
        }
      }
    } catch (err) {
      await db.update(schema.txs).set({ status: sigs.length ? "submitted" : "failed", reason: sigs.length ? "partial_needs_review" : t.reason, error: (err as Error).message.slice(0, 2000) }).where(eq(schema.txs.id, t.id));
      throw err;
    }
    const [pos] = await db
      .insert(schema.positions)
      .values({ ...base, state: "ACTIVE", dryRun: false, ourPosition: position, agentWalletId: l.agentWalletId })
      .returning({ id: schema.positions.id });
    await db.update(schema.txs).set({ status: "confirmed", positionId: pos!.id }).where(eq(schema.txs.id, t.id));
    await notify(j.userId, `[CANLI] ${label}: ${(Number(lamports) / 1e9).toFixed(4)} SOL ile pozisyon açıldı (${j.pool.slice(0, 6)}…, ${where}; ${fees}). ${sigs.length} işlem.`);
    return { opened: true, positionId: pos!.id, position };
  }

  return { close: () => worker.close() };
}
