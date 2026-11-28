import fs from "node:fs";
import { PublicKey, type Transaction } from "@solana/web3.js";
import {
  DlmmTxBuilder,
  JupiterClient,
  MM_TRIGGER_BINS,
  TxSender,
  WSOL_MINT,
  mmAddsAt,
  mmDecide,
  mmIdleExpired,
  mmPlace,
  mmRangeAfter,
  mmWidth,
  type BuiltTxs,
  type Logger,
  type MmRange,
} from "@binflip/core";

/**
 * Live follow mode: when the leader opens a position we open our own (fixed small lot) in
 * the same pool, run the engine's rebalances on OUR position ourselves, and close when the
 * leader closes (or after the idle timeout). Entries/exits come from the leader until our
 * own rules are ready; the mechanics are ours.
 *
 * Safety: started only when the service runs in live mode (DRY_RUN=0 + LIVE_CONFIRMED=1)
 * AND MM_LIVE=1; fixed lot; max open positions; wallet reserve; kill file stops new opens.
 * One action per position at a time; every action is simulated before it is signed, so a
 * move the price has already invalidated costs nothing.
 */
export interface LiveOptions {
  lotLamports: bigint;
  maxPositions: number;
  reserveLamports: bigint;
  slippageBins: number;
  priorityMicroLamports: number;
  stateFile: string;
  killFile: string;
  /** If this file exists, every open position is closed (and its token sold). */
  closeAllFile: string;
  idleSec?: number;
}

interface OurPosition {
  leaderPosition: string;
  pool: string;
  position: string;
  mintX: string;
  binStep: number;
  range: MmRange;
  openedAt: number;
  lastMoveAt: number;
  closing?: boolean;
}

export class LiveMm {
  private readonly ours = new Map<string, OurPosition>(); // by leader position
  private readonly busy = new Set<string>(); // our positions with an action in flight
  private readonly jupiter = new JupiterClient();

  constructor(
    private readonly builder: DlmmTxBuilder,
    private readonly sender: TxSender,
    private readonly owner: PublicKey,
    private readonly opts: LiveOptions,
    private readonly log: Logger,
    private readonly record: (kind: string, obj: Record<string, unknown>) => void,
  ) {
    if (fs.existsSync(opts.stateFile)) {
      for (const p of JSON.parse(fs.readFileSync(opts.stateFile, "utf8")) as OurPosition[]) this.ours.set(p.leaderPosition, { ...p, closing: false });
      log.warn({ positions: this.ours.size }, "live: restored open positions from state file");
    }
  }

  pools(): string[] {
    return [...new Set([...this.ours.values()].map((p) => p.pool))];
  }

  get openCount(): number {
    return this.ours.size + this.pending.size;
  }

  private save(): void {
    fs.writeFileSync(this.opts.stateFile + ".tmp", JSON.stringify([...this.ours.values()], null, 1));
    fs.renameSync(this.opts.stateFile + ".tmp", this.opts.stateFile);
  }

  private async sendBuilt(built: BuiltTxs): Promise<string[]> {
    const sigs: string[] = [];
    for (let i = 0; i < built.txs.length; i++) {
      const tx = built.txs[i] as Transaction;
      const r = await this.sender.send(tx, built.extraSigners.get(i) ?? [], { priorityMicroLamports: this.opts.priorityMicroLamports });
      sigs.push(r.signature);
    }
    return sigs;
  }

  // ── open ──────────────────────────────────────────────────────────────────────
  /**
   * Opens in flight, keyed by leader position. Reserved SYNCHRONOUSLY (before the first await),
   * so concurrent leader opens cannot exceed maxPositions or the SOL budget, and a duplicate open
   * signal for the same leader position is dropped. `closeRequested` records a leader close that
   * arrives while our open is still in flight: before sending we cancel, after it lands we close.
   */
  private readonly pending = new Map<string, { closeRequested: boolean; reason?: string; sent: boolean }>();

  get pendingCount(): number {
    return this.pending.size;
  }

  async onLeaderOpen(e: { leaderPosition: string; pool: string; t: number }): Promise<void> {
    if (this.ours.has(e.leaderPosition) || this.pending.has(e.leaderPosition)) return; // duplicate
    const skip = (reason: string, extra: Record<string, unknown> = {}) => this.record("live", { ...e, kind: "open_skipped", reason, ...extra });
    if (fs.existsSync(this.opts.killFile) || fs.existsSync(this.opts.closeAllFile)) return skip("kill_file");
    if (this.ours.size + this.pending.size >= this.opts.maxPositions) return skip("max_positions");
    const slot = { closeRequested: false, sent: false } as { closeRequested: boolean; reason?: string; sent: boolean };
    this.pending.set(e.leaderPosition, slot); // reservation: from here on every exit path must release it
    try {
      const info = await this.builder.poolInfo(e.pool);
      if (!info.solIsY) return skip("sol_not_y");
      const w = mmWidth(info.binStep);
      if (w > 70) return skip("too_wide", { width: w });
      // Budget: our lot plus the lots of the other opens still in flight (not yet in the balance).
      const others = BigInt(this.pending.size - 1);
      const bal = BigInt(await this.builder.connection.getBalance(this.owner, "confirmed"));
      if (bal < this.opts.lotLamports * (others + 1n) + this.opts.reserveLamports) return skip("low_balance", { balance: bal.toString(), inFlight: Number(others) });
      if (slot.closeRequested) return skip("leader_closed_before_open");

      const range = mmPlace("sol", info.activeBinId, info.binStep);
      const built = await this.builder.open({ pool: e.pool, lowerBinId: range.lower, upperBinId: range.upper, amountSol: this.opts.lotLamports, strategy: "spot", slippagePct: 1 });
      if (slot.closeRequested) return skip("leader_closed_before_open"); // last point before anything is signed
      slot.sent = true;
      const sigs = await this.sendBuilt(built);
      const now = Math.floor(Date.now() / 1000);
      const p: OurPosition = { leaderPosition: e.leaderPosition, pool: e.pool, position: built.position!, mintX: info.mintX, binStep: info.binStep, range, openedAt: now, lastMoveAt: now };
      this.ours.set(e.leaderPosition, p);
      this.pending.delete(e.leaderPosition);
      this.save();
      this.record("live", { t: now, kind: "open", ...p, lamports: this.opts.lotLamports.toString(), sigs });
      this.log.info({ pool: e.pool, position: p.position, range }, "live: opened");
      if (slot.closeRequested) await this.close(p, slot.reason ?? "leader_closed"); // leader closed while we were landing
    } catch (err) {
      this.record("live", { ...e, tFail: Math.floor(Date.now() / 1000), kind: "open_failed", sent: slot.sent, error: String((err as Error).message).slice(0, 300) });
      this.log.warn({ err: (err as Error).message, pool: e.pool, sent: slot.sent }, "live: open failed");
    } finally {
      this.pending.delete(e.leaderPosition);
    }
  }

  // ── rebalance ─────────────────────────────────────────────────────────────────
  /** A fresh active bin for a pool: move every one of our positions there that needs it. */
  onTick(pool: string, active: number): void {
    for (const p of this.ours.values()) {
      if (p.pool !== pool || p.closing || this.busy.has(p.position)) continue;
      const d = mmDecide(p.range, active, p.binStep, MM_TRIGGER_BINS);
      if (d.kind === "rebalance") void this.rebalance(p, active, d.distance);
    }
  }

  private async rebalance(p: OurPosition, active: number, distance: number): Promise<void> {
    this.busy.add(p.position);
    const t = Math.floor(Date.now() / 1000);
    try {
      const removes = [{ minBinId: p.range.lower, maxBinId: p.range.upper, bps: 10_000 }];
      const held = await this.builder.simulateWithdraw(p.pool, p.position, removes);
      const adds = mmAddsAt(held.x, held.y, p.binStep, active);
      if (!adds.length) throw new Error("empty position");
      const built = await this.builder.rebalanceOne({
        pool: p.pool, position: p.position, removes, adds,
        favorX: false, claimFee: true, maxActiveBinSlippage: this.opts.slippageBins, slippagePct: 1,
      });
      const sigs = await this.sendBuilt(built);
      p.range = mmRangeAfter(adds, active);
      p.lastMoveAt = Math.floor(Date.now() / 1000);
      this.save();
      this.record("live", { t, kind: "rebalance", position: p.position, pool: p.pool, active, distance, range: p.range, held: { x: held.x.toString(), y: held.y.toString() }, sigs });
    } catch (err) {
      // Expected when the price moved again before we landed (bin slippage): the next tick retries.
      this.record("live", { t, kind: "rebalance_failed", position: p.position, pool: p.pool, active, distance, error: String((err as Error).message).slice(0, 300) });
    } finally {
      this.busy.delete(p.position);
    }
  }

  // ── close ─────────────────────────────────────────────────────────────────────
  async onLeaderClose(leaderPosition: string, reason = "leader_closed"): Promise<void> {
    const p = this.ours.get(leaderPosition);
    if (p) return this.close(p, reason);
    const inFlight = this.pending.get(leaderPosition);
    if (inFlight) {
      // Our open has not landed yet: record the intent; onLeaderOpen cancels or closes.
      inFlight.closeRequested = true;
      inFlight.reason = reason;
      this.record("live", { t: Math.floor(Date.now() / 1000), kind: "close_deferred", reason, leaderPosition, sent: inFlight.sent });
    }
  }

  /** Idle exit as a backstop (e.g. if we missed the leader's close). */
  async checkIdle(now: number): Promise<void> {
    const closeAll = fs.existsSync(this.opts.closeAllFile);
    for (const p of [...this.ours.values()]) {
      if (p.closing) continue;
      if (closeAll) await this.close(p, "close_all_file");
      else if (mmIdleExpired(p.lastMoveAt, now, this.opts.idleSec)) await this.close(p, "idle_timeout");
    }
  }

  private async close(p: OurPosition, reason: string): Promise<void> {
    if (p.closing) return;
    p.closing = true;
    // Wait for an in-flight rebalance on this position to finish.
    for (let i = 0; i < 60 && this.busy.has(p.position); i++) await new Promise((r) => setTimeout(r, 500));
    this.busy.add(p.position);
    const t = Math.floor(Date.now() / 1000);
    try {
      const sigs = await this.sendBuilt(await this.builder.remove({ pool: p.pool, position: p.position, bps: 10_000, close: true }));
      this.ours.delete(p.leaderPosition);
      this.save();
      this.record("live", { t, kind: "close", reason, position: p.position, pool: p.pool, sigs });
      await this.sellToken(p);
    } catch (err) {
      p.closing = false; // retried by the idle check / the next close signal
      this.record("live", { t, kind: "close_failed", reason, position: p.position, pool: p.pool, error: String((err as Error).message).slice(0, 300) });
    } finally {
      this.busy.delete(p.position);
    }
  }

  /** Sell whatever of the pool's token the wallet holds: Jupiter first, the pool itself as fallback. */
  private async sellToken(p: OurPosition): Promise<void> {
    if (p.mintX === WSOL_MINT) return;
    const amount = await this.builder.tokenBalance(p.mintX);
    if (amount <= 0n) return;
    const t = Math.floor(Date.now() / 1000);
    try {
      const q = await this.jupiter.quoteToSol(p.mintX, amount, 300);
      const { tx, lastValidBlockHeight } = await this.jupiter.buildSwap(q, this.owner.toBase58(), 200_000);
      const r = await this.sender.sendVersioned(tx, lastValidBlockHeight);
      this.record("live", { t, kind: "sell", via: "jupiter", mint: p.mintX, amount: amount.toString(), outLamports: q.outAmount, sig: r.signature });
    } catch (err) {
      try {
        const s = await this.builder.swapTokenToSol({ pool: p.pool, amount, slippageBps: 300 });
        if (!s) return;
        const sigs = await this.sendBuilt(s.built);
        this.record("live", { t, kind: "sell", via: "pool", mint: p.mintX, amount: amount.toString(), outLamports: s.outLamports.toString(), sigs });
      } catch (err2) {
        this.record("live", { t, kind: "sell_failed", mint: p.mintX, amount: amount.toString(), error: `${(err as Error).message} / ${(err2 as Error).message}`.slice(0, 300) });
      }
    }
  }
}
