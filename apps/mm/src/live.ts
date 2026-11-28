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
  /**
   * Close after this long without a move (seconds). OFF unless set: on the full archive the
   * leader closed at a 55-min idle only 9–19% of the time (holdout.mjs, H3 rule view), so in
   * follow mode it would close positions the leader keeps. Missed leader closes are covered by
   * the on-chain leader position check instead.
   */
  idleSec?: number;
  /** Min spacing of outcome lookups for a rebalance in flight, from ticks (default 2000 ms). */
  settleEveryMs?: number;
  /** How often copied leader positions are checked on chain (missed-close backstop, default 60 s). */
  leaderCheckMs?: number;
  /** Non-null = our data is stale (reason): no NEW opens; recovery and closes go on. */
  stale?: () => string | null;
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
  /**
   * Persisted close intent (leader closed, idle, CLOSE_ALL). Cleared only by removing the record
   * once the close is verified: our close tx confirmed, or the position account is gone on chain.
   */
  closeRequested?: boolean;
  closeReason?: string;
  closeRequestedAt?: number;
  /** Signatures of our close txs, persisted before each broadcast. */
  closeSigs?: SentSig[];
  /**
   * A rebalance that was signed but whose outcome we did not see (lost reply, crash): its
   * signatures and the range it moves us to. While any signature is pending, no new rebalance
   * and no close is built for this position.
   */
  rebalanceInFlight?: { sigs: SentSig[]; range: MmRange; active: number; t: number };
}

/**
 * A token sale owed after a confirmed close. Written in the SAME state save that removes the
 * position, so a crash or an RPC error between close and sale cannot lose it; removed only when
 * the wallet holds none of the token any more (sold, or nothing came out).
 */
interface PendingSale {
  leaderPosition: string;
  position: string;
  pool: string;
  mintX: string;
  since: number;
  tries: number;
  nextAt: number;
  /** Our close tx signatures (persisted before broadcast): the owed amount is read from them. */
  closeSigs: SentSig[];
  /** Net token outflow of THIS position's close (raw units, decimal string); unset until read. */
  amount?: string;
  /** Raw units already sold (confirmed swaps). */
  sold: string;
  /**
   * A swap that was signed (and maybe broadcast) whose outcome has not been read yet. What it
   * sold is read from the confirmed tx itself (token and SOL balance changes), never assumed.
   */
  inFlight?: { sigs: SentSig[]; route: "jupiter" | "pool"; requested: string; sentAt: number };
  /** Route for the next attempt; a route is changed only after the previous swap is known NOT to have landed. */
  route?: "jupiter" | "pool";
}

/**
 * A signature persisted before its broadcast, with the last block height at which it can land.
 * Every outcome (open, close, sale) is resolved by the one rule TxSender.resolve():
 * confirmed → counts; failed, or expired (chain past lastValid and still not found) → does not;
 * pending → wait. No time-based guesses.
 */
interface SentSig {
  sig: string;
  lastValid?: number;
}
const asSentSig = (x: string | SentSig): SentSig => (typeof x === "string" ? { sig: x } : x); // older state files

/** Retry spacing for a sale that failed: 30 s doubling to 15 min (LP Agent style: keep trying). */
const saleBackoffSec = (tries: number) => Math.min(900, 30 * 2 ** Math.max(0, tries - 1));

/** Thrown from onSignature: the open was signed but must not be broadcast (STOP / leader close). */
class AbortBeforeBroadcast extends Error {}

/** Preparation (RPC reads + SDK build) of one action may not hold a position longer than this. */
const PREP_TIMEOUT_MS = 45_000;
/** Sending (sign → broadcast → confirm) of one action; after it the chain decides via the signature rule. */
const SEND_TIMEOUT_MS = 150_000;

class TimeoutError extends Error {}
function withTimeout<T>(p: Promise<T>, ms: number, what: string, onTimeout?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, rej) => {
    timer = setTimeout(() => { onTimeout?.(); rej(new TimeoutError(`${what} took longer than ${ms} ms`)); }, ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/** Older state files stored bare signature strings; convert every place they can occur. */
function upgradePosition<T extends OurPosition>(p: T): T {
  return {
    ...p,
    closing: false,
    closeSigs: p.closeSigs?.map(asSentSig),
    rebalanceInFlight: p.rebalanceInFlight && { ...p.rebalanceInFlight, sigs: p.rebalanceInFlight.sigs.map(asSentSig) },
  };
}
function upgradeSale(x: PendingSale): PendingSale {
  const f = x.inFlight as (PendingSale["inFlight"] & { sig?: string; lastValid?: number; amount?: string }) | undefined;
  return {
    ...x,
    closeSigs: (x.closeSigs ?? []).map(asSentSig),
    sold: x.sold ?? "0",
    nextAt: 0,
    inFlight: f && (f.sigs ? { ...f, sigs: f.sigs.map(asSentSig) } : { sigs: [{ sig: f.sig!, lastValid: f.lastValid }], route: f.route, requested: f.amount ?? "0", sentAt: f.sentAt }),
  };
}

/**
 * An open that has been (or is about to be) broadcast but whose outcome we have not seen yet.
 * Persisted BEFORE the first broadcast (position address + every signature as it is produced +
 * a pending close intent), so a lost RPC reply or a restart cannot leave a position untracked.
 */
interface OpeningRecord extends OurPosition {
  sigs: SentSig[];
  sentAt: number;
  /** The simulated SOL spend (lot + rent + fees + priority) reserved for it: survives a restart. */
  spend?: string;
}


export class LiveMm {
  private readonly ours = new Map<string, OurPosition>(); // by leader position
  private readonly opening = new Map<string, OpeningRecord>(); // broadcast, outcome unknown (persisted)
  private readonly sales = new Map<string, PendingSale>(); // owed after a confirmed close (persisted), by our position
  private readonly selling = new Set<string>();
  private readonly settleAt = new Map<string, number>(); // our position → next allowed outcome lookup (ms)
  /** One action at a time per position: rebalance, close and outcome lookups run in this chain. */
  private readonly locks = new Map<string, Promise<unknown>>();
  /** SOL set aside for opens that are being prepared or whose outcome is not known yet, by leader position. */
  private readonly reservations = new Map<string, bigint>();
  /** Positions whose range was read back from chain in this process (restart check). */
  private readonly verified = new Set<string>();
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
      const raw = JSON.parse(fs.readFileSync(opts.stateFile, "utf8")) as OurPosition[] | { positions: OurPosition[]; opening: OpeningRecord[]; sales?: PendingSale[] };
      const st = Array.isArray(raw) ? { positions: raw, opening: [] } : raw;
      for (const p of st.positions) this.ours.set(p.leaderPosition, upgradePosition(p));
      for (const o of st.opening ?? []) this.opening.set(o.leaderPosition, { ...upgradePosition(o), sigs: o.sigs.map(asSentSig) });
      for (const x of ("sales" in st ? st.sales : undefined) ?? []) this.sales.set(x.position, upgradeSale(x));
      log.warn({ positions: this.ours.size, opening: this.opening.size, sales: this.sales.size }, "live: restored state (opens with unknown outcome are resolved from chain)");
    }
  }

  /**
   * What is in flight, with ages (seconds): for /health, the stats line and the CLOSE_ALL status.
   * `idle` = nothing open, opening, being prepared, closing or owed: safe to stop the service.
   */
  status(now = Math.floor(Date.now() / 1000)) {
    const ps = [...this.ours.values()];
    const age = (ts: Array<number | undefined>) => { const v = ts.filter((x): x is number => x !== undefined); return v.length ? now - Math.min(...v) : null; };
    const s = {
      open: ps.length,
      opening: this.opening.size,
      preparing: this.pending.size,
      rebalancesInFlight: ps.filter((p) => p.rebalanceInFlight).length,
      oldestRebalanceInFlightSec: age(ps.map((p) => p.rebalanceInFlight?.t)),
      closesRequested: ps.filter((p) => p.closeRequested).length,
      oldestCloseRequestSec: age(ps.filter((p) => p.closeRequested).map((p) => p.closeRequestedAt)),
      salesOwed: this.sales.size,
      oldestSaleSec: age([...this.sales.values()].map((x) => x.since)),
      oldestOpeningSec: age([...this.opening.values()].map((o) => o.sentAt)),
      reservedLamports: this.reservedTotal().toString(),
    };
    return { ...s, idle: s.open + s.opening + s.preparing + s.salesOwed === 0 };
  }

  pools(): string[] {
    return [...new Set([...this.ours.values()].map((p) => p.pool))];
  }

  get openCount(): number {
    return this.ours.size + this.inFlight();
  }

  private save(): void {
    const st = { positions: [...this.ours.values()], opening: [...this.opening.values()], sales: [...this.sales.values()] };
    fs.writeFileSync(this.opts.stateFile + ".tmp", JSON.stringify(st, null, 1));
    fs.renameSync(this.opts.stateFile + ".tmp", this.opts.stateFile);
  }

  /**
   * Run `fn` as the only action on `key`: callers queue behind each other (no timeout fall-through).
   * The lock is taken synchronously, so a caller that checks `locks.has` right after sees it.
   */
  private exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key);
    const run = (async () => {
      if (prev) await prev.catch(() => undefined);
      return fn();
    })();
    const tail = run.catch(() => undefined);
    this.locks.set(key, tail);
    void tail.then(() => { if (this.locks.get(key) === tail) this.locks.delete(key); });
    return run;
  }

  /** Read our position's range back from chain (the truth after an open, a rebalance or a restart). */
  private async chainRange(p: OurPosition): Promise<{ lower: number; upper: number } | undefined> {
    try {
      const b = await this.builder.positionBins(p.pool, p.position);
      return { lower: b.lower, upper: b.upper };
    } catch {
      return undefined;
    }
  }

  private async syncRange(p: OurPosition, why: string): Promise<void> {
    const r = await this.chainRange(p);
    if (!r) return;
    this.verified.add(p.position);
    if (r.lower !== p.range.lower || r.upper !== p.range.upper) {
      this.record("live", { t: Math.floor(Date.now() / 1000), kind: "range_from_chain", why, position: p.position, was: { lower: p.range.lower, upper: p.range.upper }, now: r });
      p.range = { ...p.range, ...r };
      this.save();
    }
  }

  private async sendBuilt(built: BuiltTxs, onSignature?: (sig: string, lastValid: number) => Promise<void>): Promise<string[]> {
    const sigs: string[] = [];
    for (let i = 0; i < built.txs.length; i++) {
      const tx = built.txs[i] as Transaction;
      const r = await this.sender.send(tx, built.extraSigners.get(i) ?? [], { priorityMicroLamports: this.opts.priorityMicroLamports, onSignature });
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
    return this.inFlight();
  }

  /** Opens not yet in `ours`: being prepared (memory) or broadcast with unknown outcome (persisted). */
  private inFlight(): number {
    return new Set([...this.pending.keys(), ...this.opening.keys()]).size;
  }

  private stopped(): boolean {
    return fs.existsSync(this.opts.killFile) || fs.existsSync(this.opts.closeAllFile);
  }

  async onLeaderOpen(e: { leaderPosition: string; pool: string; t: number }): Promise<void> {
    if (this.ours.has(e.leaderPosition) || this.pending.has(e.leaderPosition) || this.opening.has(e.leaderPosition)) return; // duplicate
    const skip = (reason: string, extra: Record<string, unknown> = {}) => this.record("live", { ...e, kind: "open_skipped", reason, ...extra });
    if (this.stopped()) return skip("kill_file");
    const stale = this.opts.stale?.();
    if (stale) return skip("stale_data", { why: stale });
    if (this.ours.size + this.inFlight() >= this.opts.maxPositions) return skip("max_positions");
    const slot = { closeRequested: false, sent: false } as { closeRequested: boolean; reason?: string; sent: boolean };
    this.pending.set(e.leaderPosition, slot); // reservation: from here on every exit path must release it
    try {
      const info = await withTimeout(this.builder.poolInfo(e.pool), PREP_TIMEOUT_MS, "pool read");
      if (!info.solIsY) return skip("sol_not_y");
      const w = mmWidth(info.binStep);
      if (w > 70) return skip("too_wide", { width: w });
      if (slot.closeRequested) return skip("leader_closed_before_open");

      const planned = mmPlace("sol", info.activeBinId, info.binStep);
      const built = await withTimeout(this.builder.open({ pool: e.pool, lowerBinId: planned.lower, upperBinId: planned.upper, amountSol: this.opts.lotLamports, strategy: "spot", slippagePct: 1 }), PREP_TIMEOUT_MS, "open build");
      // The range the SDK actually built for (it clips a SOL-only range to the active bin it sees).
      const range: MmRange = { ...planned, ...(built.range ?? {}) };
      if (range.lower > range.upper) return skip("range_clipped_away", { planned, built: built.range });
      // Budget: what THIS tx takes from the wallet (simulated: lot + rent + fees + priority), on top
      // of the reserve and of what other opens in flight have set aside. Checked and reserved in one
      // synchronous step, so concurrent opens queue for the money instead of all failing.
      const spend = await withTimeout(this.sender.estimateSpend(built.txs[0] as Transaction, { priorityMicroLamports: this.opts.priorityMicroLamports }), PREP_TIMEOUT_MS, "open simulation");
      const bal = BigInt(await withTimeout(this.builder.connection.getBalance(this.owner, "confirmed"), PREP_TIMEOUT_MS, "balance read"));
      const held = this.reservedTotal();
      if (bal - held < spend + this.opts.reserveLamports) return skip("low_balance", { balance: bal.toString(), spend: spend.toString(), reservedForOthers: held.toString() });
      this.reservations.set(e.leaderPosition, spend);
      // Last point before anything is signed: the leader may have closed, or STOP / CLOSE_ALL may
      // have appeared while we were waiting on RPC.
      if (slot.closeRequested) return skip("leader_closed_before_open");
      if (this.stopped()) return skip("kill_file_before_send");
      const now = Math.floor(Date.now() / 1000);
      const rec: OpeningRecord = { leaderPosition: e.leaderPosition, pool: e.pool, position: built.position!, mintX: info.mintX, binStep: info.binStep, range, openedAt: now, lastMoveAt: now, sigs: [], sentAt: now, spend: spend.toString() };
      this.opening.set(e.leaderPosition, rec);
      this.save(); // position address persisted before the first broadcast
      slot.sent = true;
      let timedOut = false;
      try {
        await withTimeout(this.sendBuilt(built, async (sig, lastValid) => {
          // Runs after the sender's simulation and signing, right before the FIRST broadcast:
          // the last chance to honour STOP / CLOSE_ALL / a leader close that arrived meanwhile.
          if (rec.sigs.length === 0) {
            if (timedOut) throw new AbortBeforeBroadcast("send_timeout_before_broadcast");
            if (slot.closeRequested) throw new AbortBeforeBroadcast("leader_closed_before_broadcast");
            if (this.stopped()) throw new AbortBeforeBroadcast("kill_file_before_broadcast");
          }
          rec.sigs.push({ sig, lastValid });
          this.save();
        }), SEND_TIMEOUT_MS, "open send", () => (timedOut = true));
      } catch (err) {
        if (err instanceof AbortBeforeBroadcast || (err instanceof TimeoutError && rec.sigs.length === 0)) {
          this.opening.delete(e.leaderPosition); // nothing was broadcast: nothing to resolve
          this.save();
          return skip(err instanceof AbortBeforeBroadcast ? err.message : "send_timeout_before_broadcast");
        }
        // Outcome uncertain (lost reply, timeout, failure): the chain decides, not the error.
        this.record("live", { ...e, tFail: Math.floor(Date.now() / 1000), kind: "open_uncertain", position: rec.position, sigs: rec.sigs.map((x) => x.sig), error: String((err as Error).message).slice(0, 300) });
        this.log.warn({ err: (err as Error).message, pool: e.pool, position: rec.position }, "live: open outcome uncertain, resolving from chain");
      }
      if (slot.closeRequested) { rec.closeRequested = true; rec.closeReason = slot.reason; }
      await this.resolveOpening(rec, true);
    } catch (err) {
      this.record("live", { ...e, tFail: Math.floor(Date.now() / 1000), kind: "open_failed", sent: slot.sent, error: String((err as Error).message).slice(0, 300) });
      this.log.warn({ err: (err as Error).message, pool: e.pool, sent: slot.sent }, "live: open failed");
    } finally {
      this.pending.delete(e.leaderPosition);
      // The reservation lives while the open may still spend: until it is adopted or dropped.
      if (!this.opening.has(e.leaderPosition)) this.reservations.delete(e.leaderPosition);
    }
  }

  /** SOL set aside for opens in flight; opens restored from a state file count a lot each. */
  private reservedTotal(): bigint {
    let sum = 0n;
    for (const v of this.reservations.values()) sum += v;
    // opens restored from the state file: their persisted simulated spend (older files: the lot)
    for (const [k, o] of this.opening) if (!this.reservations.has(k)) sum += o.spend !== undefined ? BigInt(o.spend) : this.opts.lotLamports;
    return sum;
  }

  /**
   * Decide a broadcast open from the chain: position account exists → adopt it (and close it if
   * the leader already closed); every signature failed or expired (TxSender.resolve) → drop;
   * → drop; otherwise keep the record and look again on the next tick (and after a restart).
   */
  private async resolveOpening(rec: OpeningRecord, justSent = false): Promise<"adopted" | "dropped" | "unknown"> {
    let exists = false;
    try {
      exists = (await this.builder.connection.getAccountInfo(new PublicKey(rec.position), "confirmed")) !== null;
    } catch {
      return "unknown"; // RPC trouble: try again later
    }
    const now = Math.floor(Date.now() / 1000);
    if (exists) {
      const { sigs, sentAt, spend: _spend, ...p } = rec; // p keeps closeRequested: persisted with the position
      this.opening.delete(rec.leaderPosition);
      this.reservations.delete(rec.leaderPosition);
      this.ours.set(rec.leaderPosition, p);
      this.save();
      await this.syncRange(p, "open");
      this.record("live", { t: now, kind: justSent ? "open" : "open_recovered", ...p, lamports: this.opts.lotLamports.toString(), sigs: sigs.map((x) => x.sig) });
      this.log.info({ pool: p.pool, position: p.position, range: p.range, recovered: !justSent }, "live: opened");
      if (p.closeRequested) await this.close(p, p.closeReason ?? "leader_closed");
      return "adopted";
    }
    if (rec.sigs.length === 0) {
      // the signature is persisted before the first broadcast: none means nothing was ever sent
      this.opening.delete(rec.leaderPosition);
      this.save();
      this.reservations.delete(rec.leaderPosition);
      this.record("live", { t: now, kind: "open_dropped", reason: "never_signed", leaderPosition: rec.leaderPosition, position: rec.position, sigs: [] });
      return "dropped";
    }
    const out = await Promise.all(rec.sigs.map((x) => this.sender.resolve(x.sig, x.lastValid).catch(() => "pending" as const)));
    if (out.every((o) => o === "failed" || o === "expired")) {
      this.opening.delete(rec.leaderPosition);
      this.save();
      this.reservations.delete(rec.leaderPosition);
      this.record("live", { t: now, kind: "open_dropped", reason: out.every((o) => o === "failed") ? "tx_failed" : "not_landed", leaderPosition: rec.leaderPosition, position: rec.position, sigs: rec.sigs.map((x) => x.sig), outcomes: out });
      return "dropped";
    }
    // pending, or confirmed but the account is not visible yet: look again next tick
    return "unknown";
  }

  /** Resolve persisted opens with an unknown outcome (after a lost reply or a restart). */
  async recoverOpening(): Promise<void> {
    for (const rec of [...this.opening.values()]) if (!this.pending.has(rec.leaderPosition)) await this.resolveOpening(rec);
  }

  // ── rebalance ─────────────────────────────────────────────────────────────────
  /** A fresh active bin for a pool: move every one of our positions there that needs it. */
  onTick(pool: string, active: number): void {
    for (const p of this.ours.values()) {
      // A persisted close request (pending or not yet sent) blocks every new rebalance.
      if (p.pool !== pool || p.closeRequested || this.locks.has(p.position)) continue;
      if (p.rebalanceInFlight && Date.now() < (this.settleAt.get(p.position) ?? 0)) continue; // resolving: rate-limited
      const d = mmDecide(p.range, active, p.binStep, MM_TRIGGER_BINS);
      if (d.kind === "rebalance") void this.exclusive(p.position, () => this.rebalance(p, active, d.distance));
    }
  }

  /** Runs inside exclusive(p.position). */
  private async rebalance(p: OurPosition, active: number, distance: number): Promise<void> {
    const t = Math.floor(Date.now() / 1000);
    if (p.closeRequested || !this.ours.has(p.leaderPosition)) return; // a close came first
    try {
      // An earlier rebalance with an unknown outcome decides first: never two on top of each other.
      if ((await this.settleRebalance(p)) !== "none") return;
      const removes = [{ minBinId: p.range.lower, maxBinId: p.range.upper, bps: 10_000 }];
      const prep = async () => {
        const held = await this.builder.simulateWithdraw(p.pool, p.position, removes);
        const build = (at: number) => {
          const adds = mmAddsAt(held.x, held.y, p.binStep, at);
          if (!adds.length) throw new Error("empty position");
          return this.builder.rebalanceOne({
            pool: p.pool, position: p.position, removes, adds,
            favorX: false, claimFee: true, maxActiveBinSlippage: this.opts.slippageBins, slippagePct: 1,
          }).then((built) => ({ built, adds, at }));
        };
        let r = await build(active);
        // The SDK refetches the pool and its add deltas are relative to ITS active bin: if that is
        // not the bin we planned with, plan again against it (once); a second move → next tick.
        if (r.built.activeId !== undefined && r.built.activeId !== r.at) {
          r = await build(r.built.activeId);
          if (r.built.activeId !== undefined && r.built.activeId !== r.at) throw new Error(`active bin moved while building (${r.at} → ${r.built.activeId})`);
        }
        return { ...r, held };
      };
      const { built, adds, at, held } = await withTimeout(prep(), PREP_TIMEOUT_MS, "rebalance preparation");
      if (p.closeRequested) {
        this.record("live", { t, kind: "rebalance_dropped", reason: "close_requested", position: p.position, pool: p.pool });
        return;
      }
      const range = mmRangeAfter(adds, at);
      const inFlight = { sigs: [] as SentSig[], range, active: at, t };
      p.rebalanceInFlight = inFlight;
      let timedOut = false;
      let sigs: string[];
      try {
        sigs = await withTimeout(this.sendBuilt(built, async (sig, lastValid) => {
          if (inFlight.sigs.length === 0 && (timedOut || p.closeRequested)) throw new AbortBeforeBroadcast(timedOut ? "send_timeout_before_broadcast" : "close_requested_before_broadcast");
          inFlight.sigs.push({ sig, lastValid });
          this.save();
        }), SEND_TIMEOUT_MS, "rebalance send", () => (timedOut = true));
      } catch (err) {
        if (inFlight.sigs.length) {
          // signed and maybe broadcast: the chain decides on a later tick (settleRebalance)
          this.save();
          this.record("live", { t, kind: "rebalance_uncertain", position: p.position, pool: p.pool, active: at, distance, range, sigs: inFlight.sigs.map((x) => x.sig), error: String((err as Error).message).slice(0, 300) });
          return;
        }
        p.rebalanceInFlight = undefined;
        throw err;
      }
      p.rebalanceInFlight = undefined;
      p.range = range;
      p.lastMoveAt = Math.floor(Date.now() / 1000);
      this.save();
      this.record("live", { t, kind: "rebalance", position: p.position, pool: p.pool, active: at, plannedActive: active, distance, range: p.range, held: { x: held.x.toString(), y: held.y.toString() }, sigs });
      await this.syncRange(p, "rebalance");
    } catch (err) {
      // Expected when the price moved again before we landed (bin slippage): the next tick retries.
      this.record("live", { t, kind: "rebalance_failed", position: p.position, pool: p.pool, active, distance, error: String((err as Error).message).slice(0, 300) });
    }
  }

  /**
   * Resolve a rebalance with an unknown outcome (TxSender.resolve on each signature):
   * "pending" → wait (nothing new may be sent); "settled" → resolved now (confirmed: our range is
   * the planned one; failed/expired: unchanged), the next tick decides afresh; "none" → nothing open.
   */
  private async settleRebalance(p: OurPosition): Promise<"none" | "pending" | "settled"> {
    const f = p.rebalanceInFlight;
    if (!f) return "none";
    this.settleAt.set(p.position, Date.now() + (this.opts.settleEveryMs ?? 2000));
    const out = await Promise.all(f.sigs.map((x) => this.sender.resolve(x.sig, x.lastValid).catch(() => "pending" as const)));
    if (out.some((o) => o === "pending")) return "pending";
    const t = Math.floor(Date.now() / 1000);
    if (out.length && out.every((o) => o === "confirmed")) {
      p.range = f.range;
      p.lastMoveAt = t;
      this.record("live", { t, kind: "rebalance_confirmed", position: p.position, pool: p.pool, active: f.active, range: f.range, sigs: f.sigs.map((x) => x.sig) });
      p.rebalanceInFlight = undefined;
      this.save();
      await this.syncRange(p, "rebalance_confirmed");
      return "settled";
    } else {
      // rebalanceOne is a single tx, so "some confirmed" does not occur; anything else did not move us
      this.record("live", { t, kind: "rebalance_not_landed", position: p.position, pool: p.pool, sigs: f.sigs.map((x) => x.sig), outcomes: out });
    }
    p.rebalanceInFlight = undefined;
    this.save();
    return "settled";
  }

  /** Our close txs: is any still pending (may land)? Then no new close may be built. */
  private async closePending(p: OurPosition): Promise<boolean> {
    for (const x of p.closeSigs ?? []) {
      const o = await this.sender.resolve(x.sig, x.lastValid).catch(() => "pending" as const);
      if (o === "pending") return true;
    }
    return false;
  }

  // ── close ─────────────────────────────────────────────────────────────────────
  async onLeaderClose(leaderPosition: string, reason = "leader_closed"): Promise<void> {
    const p = this.ours.get(leaderPosition);
    if (p) return this.close(p, reason); // close() persists the intent first
    const rec = this.opening.get(leaderPosition);
    if (rec) {
      rec.closeRequested = true; // persisted: survives a restart before the open is resolved
      rec.closeReason = reason;
      this.save();
    }
    const inFlight = this.pending.get(leaderPosition);
    if (rec && !inFlight) this.record("live", { t: Math.floor(Date.now() / 1000), kind: "close_deferred", reason, leaderPosition, sent: true });
    if (inFlight) {
      // Our open has not landed yet: record the intent; onLeaderOpen cancels or closes.
      inFlight.closeRequested = true;
      inFlight.reason = reason;
      this.record("live", { t: Math.floor(Date.now() / 1000), kind: "close_deferred", reason, leaderPosition, sent: inFlight.sent });
    }
  }

  /** Idle exit as a backstop (e.g. if we missed the leader's close). */
  /**
   * Backstop for a missed leader close (unreadable tx, downtime gap): every leader position we
   * copy (open or opening) is checked on chain; gone → treated as the leader's close.
   */
  async reconcileLeaderPositions(why = "periodic"): Promise<void> {
    const leaderPositions = [...new Set([...this.ours.keys(), ...this.opening.keys()])];
    if (!leaderPositions.length) return;
    const infos = await this.builder.connection.getMultipleAccountsInfo(leaderPositions.map((k) => new PublicKey(k)), "confirmed");
    for (const [i, lp] of leaderPositions.entries()) {
      if (infos[i] !== null) continue;
      this.record("live", { t: Math.floor(Date.now() / 1000), kind: "leader_position_gone", why, leaderPosition: lp });
      await this.onLeaderClose(lp, "leader_position_gone");
    }
  }

  private lastLeaderCheck = Date.now(); // main calls reconcileLeaderPositions("startup") itself

  /** Sales owed after a close; true while any is still pending. */
  get pendingSales(): number {
    return this.sales.size;
  }

  async checkIdle(now: number): Promise<void> {
    // CLOSE_ALL first, before anything that can wait on RPC: every position's close intent is
    // persisted at once (a stuck sale or a slow recovery must not keep it from being recorded).
    const closeAll = fs.existsSync(this.opts.closeAllFile);
    if (closeAll) {
      let changed = false;
      for (const p of this.ours.values()) {
        if (p.closeRequested) continue;
        p.closeRequested = true;
        p.closeReason = "close_all_file";
        p.closeRequestedAt = Math.floor(Date.now() / 1000);
        changed = true;
      }
      for (const o of this.opening.values()) if (!o.closeRequested) { o.closeRequested = true; o.closeReason = "close_all_file"; changed = true; }
      if (changed) this.save();
    }
    await this.recoverOpening();
    if (Date.now() - this.lastLeaderCheck >= (this.opts.leaderCheckMs ?? 60_000)) {
      this.lastLeaderCheck = Date.now();
      await this.reconcileLeaderPositions().catch((err) => this.log.warn({ err: (err as Error).message }, "live: leader position check failed"));
    }
    // Sales start now and run alongside the closes below; closes never wait for them. The tick waits
    // for them at the END, bounded (a sale stuck on RPC keeps running, one per position).
    const sales = this.retrySales(now);
    for (const p of [...this.ours.values()]) {
      if (p.closing) continue;
      // A rebalance in flight is resolved here too: the price may have come back, so no tick
      // would ask for a rebalance, and our range must not stay stale. After a restart every
      // position's range is read back from chain once.
      if (!this.locks.has(p.position) && (p.rebalanceInFlight || !this.verified.has(p.position))) {
        await this.exclusive(p.position, async () => {
          if (p.rebalanceInFlight) await this.settleRebalance(p);
          if (!this.verified.has(p.position)) await this.syncRange(p, "restart");
        });
      }
      if (p.closeRequested) await this.close(p, p.closeReason ?? "leader_closed"); // restored intent
      else if (closeAll) await this.close(p, "close_all_file");
      else if (this.opts.idleSec && mmIdleExpired(p.lastMoveAt, now, this.opts.idleSec)) await this.close(p, "idle_timeout");
    }
    await withTimeout(sales, PREP_TIMEOUT_MS, "sales").catch(() => undefined);
  }

  private async close(p: OurPosition, reason: string): Promise<void> {
    if (!p.closeRequested) {
      p.closeRequested = true; // persisted before anything is sent: survives a crash from here on
      p.closeReason = reason;
      p.closeRequestedAt = Math.floor(Date.now() / 1000);
      this.save();
    }
    if (p.closing) return;
    p.closing = true;
    try {
      // Queues behind any action on this position (a rebalance being prepared or sent): no parallel
      // close; a rebalance that has not signed yet sees closeRequested and drops itself.
      await this.exclusive(p.position, () => this.closeNow(p, reason));
    } finally {
      p.closing = false;
    }
  }

  /** Runs inside exclusive(p.position). */
  private async closeNow(p: OurPosition, reason: string): Promise<void> {
    if (!this.ours.has(p.leaderPosition)) return;
    const t = Math.floor(Date.now() / 1000);
    const done = async (kind: string, sigs: string[]) => {
      // One atomic save: the position (with its close intent) goes, the owed sale comes.
      if (p.mintX !== WSOL_MINT) this.sales.set(p.position, { leaderPosition: p.leaderPosition, position: p.position, pool: p.pool, mintX: p.mintX, since: t, tries: 0, nextAt: 0, closeSigs: [...(p.closeSigs ?? [])], sold: "0" });
      this.ours.delete(p.leaderPosition); // the only place a close intent is cleared
      this.save();
      this.record("live", { t, kind, reason, position: p.position, pool: p.pool, sigs });
      // bounded: a sale stuck on RPC keeps running in the background (one per position) and the
      // next close is not held up; the owed amount is persisted either way
      await withTimeout(this.runSale(p.position, t), PREP_TIMEOUT_MS, "sale after close").catch(() => undefined);
    };
    try {
      // A previous close may have landed with its reply lost (or before a crash): verify on chain.
      if ((await withTimeout(this.builder.connection.getAccountInfo(new PublicKey(p.position), "confirmed"), PREP_TIMEOUT_MS, "position read")) === null) return await done("close_verified", []);
      // The same signature rule before building anything new: a close or a rebalance of ours that
      // may still land → wait for it (the intent stays persisted; the next tick looks again).
      if ((await this.settleRebalance(p)) === "pending" || (await this.closePending(p))) return;
      const built = await withTimeout(this.builder.remove({ pool: p.pool, position: p.position, bps: 10_000, close: true }), PREP_TIMEOUT_MS, "close build");
      let timedOut = false;
      let signed = 0;
      const sigs = await withTimeout(this.sendBuilt(built, async (sig, lastValid) => {
        if (signed === 0 && timedOut) throw new AbortBeforeBroadcast("send_timeout_before_broadcast");
        signed++;
        (p.closeSigs ??= []).push({ sig, lastValid });
        this.save();
      }), SEND_TIMEOUT_MS, "close send", () => (timedOut = true));
      await done("close", sigs);
    } catch (err) {
      // retried by the next tick (the intent is persisted); a recorded signature is resolved first
      this.record("live", { t, kind: "close_failed", reason, position: p.position, pool: p.pool, error: String((err as Error).message).slice(0, 300) });
    }
  }

  private retrySales(now: number): Promise<unknown> {
    const due = [...this.sales.values()].filter((x) => now >= x.nextAt);
    return Promise.allSettled(due.map((x) => this.runSale(x.position, now).catch((err) => this.log.warn({ err: (err as Error).message }, "live: sale pass failed"))));
  }

  /**
   * Net change of `mint` in our wallet over our close txs, each resolved by TxSender.resolve():
   * confirmed → counted; failed / expired → left out (e.g. a first close attempt that never
   * landed, followed by a confirmed retry); any still pending → undefined (wait).
   * `confirmed` = how many close txs actually landed.
   */
  private async closeOutflow(sigs: SentSig[], mint: string): Promise<{ amount: bigint; confirmed: number } | undefined> {
    let amount = 0n, confirmed = 0;
    const me = this.owner.toBase58();
    for (const x of sigs) {
      const o = await this.sender.resolve(x.sig, x.lastValid);
      if (o === "failed" || o === "expired") continue;
      if (o === "pending") return undefined;
      const tx = await this.builder.connection.getTransaction(x.sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      if (!tx?.meta) return undefined; // confirmed but not readable yet
      if (tx.meta.err) continue;
      const amt = (list: typeof tx.meta.postTokenBalances) =>
        (list ?? []).filter((b) => b.mint === mint && b.owner === me).reduce((a, b) => a + BigInt(b.uiTokenAmount.amount), 0n);
      amount += amt(tx.meta.postTokenBalances) - amt(tx.meta.preTokenBalances);
      confirmed++;
    }
    return { amount, confirmed };
  }

  /**
   * What a swap's signatures did, read from chain: pending (any may still land, or a confirmed tx
   * is not readable yet) → undefined; otherwise the token our wallet actually gave up and the SOL
   * it actually received over the confirmed ones (a partial fill counts what it filled), and
   * whether anything landed at all.
   */
  private async swapOutcome(sigs: SentSig[], mint: string): Promise<{ landed: boolean; sold: bigint; solIn: bigint } | undefined> {
    let landed = false, sold = 0n, solIn = 0n;
    const me = this.owner.toBase58();
    for (const x of sigs) {
      const o = await this.sender.resolve(x.sig, x.lastValid);
      if (o === "pending") return undefined;
      if (o !== "confirmed") continue;
      const tx = await this.builder.connection.getTransaction(x.sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      if (!tx?.meta) return undefined;
      if (tx.meta.err) continue;
      const amt = (list: typeof tx.meta.postTokenBalances) =>
        (list ?? []).filter((b) => b.mint === mint && b.owner === me).reduce((a, b) => a + BigInt(b.uiTokenAmount.amount), 0n);
      sold += amt(tx.meta.preTokenBalances) - amt(tx.meta.postTokenBalances);
      solIn += BigInt(tx.meta.postBalances[0] ?? 0) - BigInt(tx.meta.preBalances[0] ?? 0); // we are the fee payer (index 0)
      landed = true;
    }
    return { landed, sold, solIn };
  }

  /**
   * Sell what THIS close released, never more: the owed amount is the close txs' net token
   * outflow for the position (other tokens of the same mint in the wallet are left alone), and
   * each pass sells min(owed − sold, balance).
   *
   * Every swap's signatures are persisted before broadcast, and what a swap sold is READ from the
   * confirmed tx (a pool that fills 400 of 1000 counts 400; the other 600 stay owed). The outcome
   * of each swap is resolved by TxSender.resolve(): pending → wait; failed or expired → not sold,
   * and only then may the other route be used. `sell_done` is written only when nothing is owed;
   * a zero wallet balance while tokens are owed is waited out (it can be a stale RPC answer).
   */
  private async runSale(position: string, now: number): Promise<void> {
    const x = this.sales.get(position);
    if (!x || this.selling.has(position)) return;
    this.selling.add(position);
    const t = Math.floor(Date.now() / 1000);
    const retryLater = (error: string, kind = "sell_failed") => {
      x.tries++;
      x.nextAt = now + saleBackoffSec(x.tries);
      this.save();
      this.record("live", { t, kind, mint: x.mintX, position, owed: x.amount === undefined ? null : (BigInt(x.amount) - BigInt(x.sold)).toString(), tries: x.tries, retryInSec: saleBackoffSec(x.tries), error: error.slice(0, 300) });
    };
    /** Account for the swap in flight; true when it is settled (landed or known not to have). */
    const settleInFlight = async (): Promise<boolean> => {
      const f = x.inFlight;
      if (!f) return true;
      const r = await this.swapOutcome(f.sigs, x.mintX);
      if (!r) return false;
      if (r.landed) {
        x.sold = (BigInt(x.sold) + r.sold).toString();
        this.record("live", { t, kind: "sell", via: f.route, mint: x.mintX, position, requested: f.requested, amount: r.sold.toString(), outLamports: r.solIn.toString(), sigs: f.sigs.map((s) => s.sig), owed: x.amount === undefined ? null : (BigInt(x.amount) - BigInt(x.sold)).toString() });
      } else {
        this.record("live", { t, kind: "sell_not_landed", via: f.route, mint: x.mintX, position, sigs: f.sigs.map((s) => s.sig) });
        x.route = f.route === "jupiter" ? "pool" : "jupiter";
      }
      x.inFlight = undefined;
      x.nextAt = 0;
      this.save();
      return true;
    };
    try {
      // 1) a swap from an earlier pass with an unknown outcome: resolve it first
      if (!(await settleInFlight())) {
        x.nextAt = now + 5; // may still land: no new swap until it is known
        return;
      }
      // 2) how much this close released
      if (x.amount === undefined) {
        if (!x.closeSigs.length) {
          // closed by someone else / before close signatures were recorded: amount unknown, sell nothing
          this.sales.delete(position);
          this.save();
          this.record("live", { t, kind: "sell_skipped", reason: "unknown_close_amount", mint: x.mintX, position });
          return;
        }
        const d = await this.closeOutflow(x.closeSigs, x.mintX);
        if (d === undefined) return retryLater("close outcome pending / tx not readable yet");
        if (d.confirmed === 0) {
          // none of our close txs landed: the position was closed by something else, amount unknown
          this.sales.delete(position);
          this.save();
          this.record("live", { t, kind: "sell_skipped", reason: "no_confirmed_close", mint: x.mintX, position });
          return;
        }
        x.amount = (d.amount > 0n ? d.amount : 0n).toString();
        this.save();
      }
      const owed = BigInt(x.amount) - BigInt(x.sold);
      if (owed <= 0n) {
        this.sales.delete(position);
        this.save();
        this.record("live", { t, kind: "sell_done", mint: x.mintX, position, amount: x.amount, sold: x.sold, tries: x.tries });
        return;
      }
      const bal = await withTimeout(this.builder.tokenBalance(x.mintX), PREP_TIMEOUT_MS, "token balance read");
      const amount = owed < bal ? owed : bal;
      if (amount <= 0n) return retryLater(`owed ${owed} but the wallet shows ${bal}`, "sell_waiting_balance");
      // 3) one swap; signatures persisted before broadcast; the outcome is read from chain
      const mark = (route: "jupiter" | "pool") => async (sig: string, lastValid: number) => {
        x.inFlight ??= { sigs: [], route, requested: amount.toString(), sentAt: Math.floor(Date.now() / 1000) };
        x.inFlight.sigs.push({ sig, lastValid });
        this.save();
      };
      const afterSend = async (err?: unknown) => {
        if (!x.inFlight) return false; // never signed
        if (!(await settleInFlight())) {
          retryLater(`${x.inFlight?.route} outcome unknown, resolving from chain${err ? `: ${(err as Error).message}` : ""}`);
          return true;
        }
        return true;
      };
      const errors: string[] = [];
      if ((x.route ?? "jupiter") === "jupiter") {
        try {
          const q = await withTimeout(this.jupiter.quoteToSol(x.mintX, amount, 300), PREP_TIMEOUT_MS, "jupiter quote");
          const { tx, lastValidBlockHeight } = await withTimeout(this.jupiter.buildSwap(q, this.owner.toBase58(), 200_000), PREP_TIMEOUT_MS, "jupiter build");
          await this.sender.sendVersioned(tx, lastValidBlockHeight, { onSignature: mark("jupiter") });
          await afterSend();
          return;
        } catch (err) {
          if (await afterSend(err)) return; // signed: NO fallback until it is known not to have landed
          errors.push(`jupiter: ${(err as Error).message}`); // never signed: the pool route is safe
        }
      }
      try {
        const s2 = await withTimeout(this.builder.swapTokenToSol({ pool: x.pool, amount, slippageBps: 300 }), PREP_TIMEOUT_MS, "pool quote");
        if (!s2) throw new Error("no pool route");
        await this.sendBuilt(s2.built, mark("pool"));
        await afterSend();
      } catch (err) {
        if (await afterSend(err)) return;
        errors.push(`pool: ${(err as Error).message}`);
        x.route = "jupiter"; // nothing was signed on either route: start over next time
        return retryLater(errors.join(" / "));
      }
    } catch (err) {
      return retryLater(String((err as Error).message));
    } finally {
      this.selling.delete(position);
    }
  }
}
