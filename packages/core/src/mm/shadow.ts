import { MM_TRIGGER_BINS, mmDecide, mmDistance, mmIdleExpired, sameRange, type MmRange } from "./engine.js";

/**
 * Shadow book: mirrors a leader's (BviQ's) open positions, runs our engine on the
 * same pool prices, and scores every leader rebalance against what we decided.
 *
 * After each leader rebalance our position is re-synced to the leader's new range,
 * so one disagreement never snowballs into the next comparison.
 */

export interface ShadowPosition {
  position: string;
  pool: string;
  binStep: number;
  range: MmRange;
  /** Our decisions since the last sync with the leader. */
  pending: Array<{ t: number; active: number; next: MmRange; distance: number }>;
  openedAt: number;
  /** Block time of the last leader move we re-synced to. */
  syncedAt?: number;
  /** Last rebalance by either side (our idle timer). */
  lastMoveAt: number;
  /** Last rebalance by the leader (to classify the leader's own close). */
  leaderMoveAt: number;
  /** When our idle rule said "close" (once per position). */
  predictedCloseAt?: number;
}

export type ExitOutcome =
  | "exit_match" //  our idle rule fired within ±5 min of the leader's close
  | "exit_early" //  our idle rule fired more than 5 min before the leader closed
  | "exit_other"; // the leader closed while our idle timer had not run out (another exit rule)

export interface ExitComparison {
  t: number;
  position: string;
  pool: string;
  outcome: ExitOutcome;
  /** Leader's close − its last rebalance (or open), minutes. */
  leaderIdleMin: number;
  /** Our "close" − the leader's close, seconds (negative: we were earlier). */
  lagSec?: number;
}

export type ShadowOutcome =
  | "match" //            we moved to exactly the leader's range
  | "match_other_bin" //  same side and width, but the price had moved: different bins
  | "wrong_side" //       we moved to the other side
  | "missed" //           we saw the trigger distance but did not decide (a rule gap)
  | "not_seen" //         the leader moved before our last pool read showed the trigger (speed, not rules)
  | "adopted"; //         first time we see this position (started mid-life), no score

export interface ShadowComparison {
  t: number;
  position: string;
  pool: string;
  outcome: ShadowOutcome;
  leader: { active: number; next: MmRange; distance: number };
  ours?: { t: number; active: number; next: MmRange };
  /** Our decision time − leader block time, seconds (negative: we were earlier). */
  lagSec?: number;
  /** Our decisions the leader never made (since the previous sync). */
  extra: number;
}

export interface ShadowStats {
  compared: number;
  match: number;
  matchOtherBin: number;
  wrongSide: number;
  missed: number;
  notSeen: number;
  adopted: number;
  extra: number;
  closedWithPending: number;
  lagSec: number[];
  exits: number;
  exitMatch: number;
  exitEarly: number;
  exitOther: number;
}

export class ShadowBook {
  private readonly positions = new Map<string, ShadowPosition>();
  /** Recent active-bin reads per pool (bounded), to tell a rule gap from a speed gap. */
  private readonly reads = new Map<string, Array<{ t: number; active: number }>>();
  readonly stats: ShadowStats = { compared: 0, match: 0, matchOtherBin: 0, wrongSide: 0, missed: 0, notSeen: 0, adopted: 0, extra: 0, closedWithPending: 0, lagSec: [], exits: 0, exitMatch: 0, exitEarly: 0, exitOther: 0 };

  constructor(
    private readonly trigger?: number,
    private readonly idleSec?: number,
  ) {}

  get open(): ShadowPosition[] {
    return [...this.positions.values()];
  }

  pools(): string[] {
    return [...new Set(this.open.map((p) => p.pool))];
  }

  has(position: string): boolean {
    return this.positions.has(position);
  }

  /** Leader opened a position. */
  onOpen(p: { position: string; pool: string; binStep: number; range: MmRange; t: number }): void {
    this.positions.set(p.position, { position: p.position, pool: p.pool, binStep: p.binStep, range: p.range, pending: [], openedAt: p.t, lastMoveAt: p.t, leaderMoveAt: p.t });
  }

  /** Run the idle-exit rule on every open position; returns the ones that just expired. */
  checkExits(now: number): ShadowPosition[] {
    const out: ShadowPosition[] = [];
    for (const p of this.positions.values()) {
      if (p.predictedCloseAt === undefined && mmIdleExpired(p.lastMoveAt, now, this.idleSec)) {
        p.predictedCloseAt = now;
        out.push(p);
      }
    }
    return out;
  }

  /** Leader closed a position: score our exit rule; our undecided-by-leader moves count as extra. */
  onClose(position: string, t: number): { position: ShadowPosition; exit: ExitComparison } | undefined {
    const p = this.positions.get(position);
    if (!p) return undefined;
    if (p.pending.length) {
      this.stats.closedWithPending++;
      this.stats.extra += p.pending.length;
    }
    const leaderIdleMin = Math.round(((t - p.leaderMoveAt) / 60) * 10) / 10;
    let outcome: ExitOutcome;
    let lagSec: number | undefined;
    if (p.predictedCloseAt === undefined) outcome = "exit_other";
    else {
      lagSec = p.predictedCloseAt - t;
      outcome = lagSec >= -300 ? "exit_match" : "exit_early";
    }
    this.stats.exits++;
    if (outcome === "exit_match") this.stats.exitMatch++;
    else if (outcome === "exit_early") this.stats.exitEarly++;
    else this.stats.exitOther++;
    this.positions.delete(position);
    return { position: p, exit: { t, position, pool: p.pool, outcome, leaderIdleMin, lagSec } };
  }

  /** A fresh active bin for a pool: run the engine on every shadow position there. */
  onTick(pool: string, active: number, t: number): Array<{ position: string; next: MmRange; distance: number }> {
    const out: Array<{ position: string; next: MmRange; distance: number }> = [];
    const hist = this.reads.get(pool) ?? [];
    hist.push({ t, active });
    if (hist.length > 300) hist.splice(0, hist.length - 300); // ~10 min at 2 s
    this.reads.set(pool, hist);
    for (const p of this.positions.values()) {
      if (p.pool !== pool) continue;
      const d = mmDecide(p.range, active, p.binStep, this.trigger);
      if (d.kind !== "rebalance") continue;
      p.pending.push({ t, active, next: d.next, distance: d.distance });
      p.range = d.next; // assume our move lands; the leader's next event re-syncs us
      p.lastMoveAt = Math.max(p.lastMoveAt, t);
      out.push({ position: p.position, next: d.next, distance: d.distance });
    }
    return out;
  }

  /** The leader rebalanced. Score our pending decisions, then re-sync to the leader. */
  onLeaderRebalance(e: {
    position: string;
    pool: string;
    binStep: number;
    t: number;
    active: number;
    old: Pick<MmRange, "lower" | "upper">;
    next: MmRange;
  }): ShadowComparison {
    const distance = e.active > e.old.upper ? e.active - e.old.upper : e.active < e.old.lower ? e.active - e.old.lower : 0;
    const leader = { active: e.active, next: e.next, distance };
    const p = this.positions.get(e.position);
    if (!p) {
      this.positions.set(e.position, { position: e.position, pool: e.pool, binStep: e.binStep, range: e.next, pending: [], openedAt: e.t, lastMoveAt: e.t, leaderMoveAt: e.t });
      this.stats.adopted++;
      return { t: e.t, position: e.position, pool: e.pool, outcome: "adopted", leader, extra: 0 };
    }

    // The decision that answers this leader move is our first one since the last sync.
    const ours = p.pending[0];
    const extra = Math.max(0, p.pending.length - 1);
    let outcome: ShadowOutcome;
    if (!ours) {
      // Did any read taken after our last sync and strictly before the leader's block
      // already show the leader's 2-bin trigger against the range we both held?
      const since = p.syncedAt ?? p.openedAt;
      const sawTrigger = (this.reads.get(e.pool) ?? []).some(
        (r) => r.t >= since && r.t < e.t && Math.abs(mmDistance(e.old, r.active)) >= MM_TRIGGER_BINS,
      );
      outcome = sawTrigger ? "missed" : "not_seen";
    }
    else if (ours.next.side !== e.next.side) outcome = "wrong_side";
    else if (sameRange(ours.next, e.next)) outcome = "match";
    else outcome = "match_other_bin";

    this.stats.compared++;
    this.stats.extra += extra;
    if (outcome === "match") this.stats.match++;
    else if (outcome === "match_other_bin") this.stats.matchOtherBin++;
    else if (outcome === "wrong_side") this.stats.wrongSide++;
    else if (outcome === "missed") this.stats.missed++;
    else this.stats.notSeen++;
    const lagSec = ours ? ours.t - e.t : undefined;
    if (lagSec !== undefined) this.stats.lagSec.push(lagSec);
    if (this.stats.lagSec.length > 20_000) this.stats.lagSec.splice(0, 10_000);

    p.range = e.next;
    p.pending = [];
    p.syncedAt = e.t;
    p.leaderMoveAt = e.t;
    p.lastMoveAt = Math.max(p.lastMoveAt, e.t);
    p.predictedCloseAt = undefined; // a move resets the idle timer
    return { t: e.t, position: e.position, pool: e.pool, outcome, leader, ours: ours && { t: ours.t, active: ours.active, next: ours.next }, lagSec, extra };
  }

  /** Compact summary for logs. */
  summary(): Record<string, number | null> {
    const s = this.stats;
    const lag = [...s.lagSec].sort((a, b) => a - b);
    const q = (p: number) => (lag.length ? lag[Math.min(lag.length - 1, Math.floor(p * lag.length))]! : null);
    const pct = (n: number) => (s.compared ? Math.round((n / s.compared) * 1000) / 10 : null);
    return {
      open: this.positions.size,
      compared: s.compared,
      matchPct: pct(s.match),
      sameSidePct: pct(s.match + s.matchOtherBin),
      wrongSidePct: pct(s.wrongSide),
      missedPct: pct(s.missed),
      notSeenPct: pct(s.notSeen),
      extra: s.extra,
      adopted: s.adopted,
      lagP10: q(0.1),
      lagP50: q(0.5),
      lagP90: q(0.9),
      exits: s.exits,
      exitMatchPct: s.exits ? Math.round((s.exitMatch / s.exits) * 1000) / 10 : null,
      exitEarlyPct: s.exits ? Math.round((s.exitEarly / s.exits) * 1000) / 10 : null,
      exitOtherPct: s.exits ? Math.round((s.exitOther / s.exits) * 1000) / 10 : null,
    };
  }
}
