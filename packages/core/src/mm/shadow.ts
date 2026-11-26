import { mmDecide, sameRange, type MmRange } from "./engine.js";

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
}

export type ShadowOutcome =
  | "match" //            we moved to exactly the leader's range
  | "match_other_bin" //  same side and width, but the price had moved: different bins
  | "wrong_side" //       we moved to the other side
  | "missed" //           the leader moved, we had not decided to
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
  adopted: number;
  extra: number;
  closedWithPending: number;
  lagSec: number[];
}

export class ShadowBook {
  private readonly positions = new Map<string, ShadowPosition>();
  readonly stats: ShadowStats = { compared: 0, match: 0, matchOtherBin: 0, wrongSide: 0, missed: 0, adopted: 0, extra: 0, closedWithPending: 0, lagSec: [] };

  constructor(private readonly trigger?: number) {}

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
    this.positions.set(p.position, { position: p.position, pool: p.pool, binStep: p.binStep, range: p.range, pending: [], openedAt: p.t });
  }

  /** Leader closed a position. Our undecided-by-leader moves count as extra. */
  onClose(position: string): ShadowPosition | undefined {
    const p = this.positions.get(position);
    if (!p) return undefined;
    if (p.pending.length) {
      this.stats.closedWithPending++;
      this.stats.extra += p.pending.length;
    }
    this.positions.delete(position);
    return p;
  }

  /** A fresh active bin for a pool: run the engine on every shadow position there. */
  onTick(pool: string, active: number, t: number): Array<{ position: string; next: MmRange; distance: number }> {
    const out: Array<{ position: string; next: MmRange; distance: number }> = [];
    for (const p of this.positions.values()) {
      if (p.pool !== pool) continue;
      const d = mmDecide(p.range, active, p.binStep, this.trigger);
      if (d.kind !== "rebalance") continue;
      p.pending.push({ t, active, next: d.next, distance: d.distance });
      p.range = d.next; // assume our move lands; the leader's next event re-syncs us
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
      this.positions.set(e.position, { position: e.position, pool: e.pool, binStep: e.binStep, range: e.next, pending: [], openedAt: e.t });
      this.stats.adopted++;
      return { t: e.t, position: e.position, pool: e.pool, outcome: "adopted", leader, extra: 0 };
    }

    // The decision that answers this leader move is our first one since the last sync.
    const ours = p.pending[0];
    const extra = Math.max(0, p.pending.length - 1);
    let outcome: ShadowOutcome;
    if (!ours) outcome = "missed";
    else if (ours.next.side !== e.next.side) outcome = "wrong_side";
    else if (sameRange(ours.next, e.next)) outcome = "match";
    else outcome = "match_other_bin";

    this.stats.compared++;
    this.stats.extra += extra;
    if (outcome === "match") this.stats.match++;
    else if (outcome === "match_other_bin") this.stats.matchOtherBin++;
    else if (outcome === "wrong_side") this.stats.wrongSide++;
    else this.stats.missed++;
    const lagSec = ours ? ours.t - e.t : undefined;
    if (lagSec !== undefined) this.stats.lagSec.push(lagSec);
    if (this.stats.lagSec.length > 20_000) this.stats.lagSec.splice(0, 10_000);

    p.range = e.next;
    p.pending = [];
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
      extra: s.extra,
      adopted: s.adopted,
      lagP10: q(0.1),
      lagP50: q(0.5),
      lagP90: q(0.9),
    };
  }
}
