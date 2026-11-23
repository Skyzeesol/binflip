/**
 * Leader statistics LP Agent shows in the copy dialog:
 * - average position age (High-frequency warning under 18 minutes),
 * - how often the leader re-adds the same token within 1 / 5 minutes of an exit
 *   (the case Smart Token Retention is for).
 */
export interface LeaderMove {
  kind: "open" | "add" | "remove" | "close" | "claim" | "rebalance";
  position: string;
  pool: string | null;
  at: Date;
}

export interface LeaderStats {
  /** Average open→close time of positions whose open and close we both saw. */
  avgHoldMinutes: number | null;
  closedSample: number;
  /** Share of exits followed by an open/add in the same pool within 1 / 5 minutes. */
  reAdd1mPct: number | null;
  reAdd5mPct: number | null;
  exitSample: number;
  highFrequency: boolean;
}

export const HIGH_FREQUENCY_MINUTES = 18;

export function leaderStats(moves: LeaderMove[]): LeaderStats {
  const sorted = [...moves].sort((a, b) => a.at.getTime() - b.at.getTime());
  const opened = new Map<string, Date>();
  const holds: number[] = [];
  for (const m of sorted) {
    if (m.kind === "open" && !opened.has(m.position)) opened.set(m.position, m.at);
    if (m.kind === "close") {
      const o = opened.get(m.position);
      if (o) holds.push((m.at.getTime() - o.getTime()) / 60_000);
    }
  }
  const exits = sorted.filter((m) => (m.kind === "close" || m.kind === "remove") && m.pool);
  const entries = sorted.filter((m) => (m.kind === "open" || m.kind === "add") && m.pool);
  const within = (ms: number) =>
    exits.filter((e) => entries.some((n) => n.pool === e.pool && n.at > e.at && n.at.getTime() - e.at.getTime() <= ms)).length;
  const avg = holds.length ? holds.reduce((s, v) => s + v, 0) / holds.length : null;
  return {
    avgHoldMinutes: avg,
    closedSample: holds.length,
    reAdd1mPct: exits.length ? (within(60_000) / exits.length) * 100 : null,
    reAdd5mPct: exits.length ? (within(300_000) / exits.length) * 100 : null,
    exitSample: exits.length,
    highFrequency: avg !== null && avg < HIGH_FREQUENCY_MINUTES,
  };
}
