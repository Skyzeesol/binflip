/**
 * Portfolio numbers, the way LP Agent defines them (docs.lpagent.io/features/portfolio):
 * Total Closed, Win Rate, Avg Invested, Fee Earned, Total Profit, Avg Monthly Profit,
 * Expected Value = winRate × avgWin + lossRate × avgLoss (avgLoss negative).
 * All amounts in SOL.
 */

export interface PositionNumbers {
  invested: number;
  /** Current (or final) value incl. unclaimed fees. */
  value: number | null;
  claimedFee: number;
  /** Claimed fees that went back into the position (already inside `value`). */
  compoundedFee: number;
  unclaimedFee: number;
  openedAt: Date | null;
  closedAt: Date | null;
}

export interface PositionMetrics {
  totalFee: number;
  feePct: number | null;
  pnl: number | null;
  pnlPct: number | null;
  ageMs: number | null;
  /** Daily percentage rate: fees as % of invested, per day. */
  dpr: number | null;
}

const DAY = 86_400_000;

export function positionMetrics(p: PositionNumbers, now = new Date()): PositionMetrics {
  const totalFee = p.claimedFee + p.unclaimedFee;
  const feePct = p.invested > 0 ? (totalFee / p.invested) * 100 : null;
  // Claimed fees that left the position are profit on top of its value; compounded ones are already in it.
  const pnl = p.value === null || p.invested <= 0 ? null : p.value + (p.claimedFee - p.compoundedFee) - p.invested;
  const pnlPct = pnl === null ? null : (pnl / p.invested) * 100;
  const end = p.closedAt ?? now;
  const ageMs = p.openedAt ? Math.max(0, end.getTime() - p.openedAt.getTime()) : null;
  const dpr = feePct !== null && ageMs !== null && ageMs > 0 ? feePct / Math.max(ageMs / DAY, 1 / 24) : null;
  return { totalFee, feePct, pnl, pnlPct, ageMs, dpr };
}

export interface Summary {
  totalClosed: number;
  winRate: number | null;
  avgInvested: number | null;
  feeEarned: number;
  totalProfit: number;
  avgMonthlyProfit: number | null;
  expectedValue: number | null;
}

export function summarize(closed: Array<{ invested: number; pnl: number | null; firstAt: Date | null }>, allFees: number, now = new Date()): Summary {
  const done = closed.filter((c) => c.pnl !== null) as Array<{ invested: number; pnl: number; firstAt: Date | null }>;
  const wins = done.filter((c) => c.pnl > 0);
  const losses = done.filter((c) => c.pnl <= 0);
  const totalProfit = done.reduce((s, c) => s + c.pnl, 0);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const winRate = done.length ? wins.length / done.length : null;
  const first = done.reduce<Date | null>((m, c) => (c.firstAt && (!m || c.firstAt < m) ? c.firstAt : m), null);
  const months = first ? Math.max(1, (now.getTime() - first.getTime()) / (30 * DAY)) : null;
  return {
    totalClosed: closed.length,
    winRate: winRate === null ? null : winRate * 100,
    avgInvested: closed.length ? avg(closed.map((c) => c.invested)) : null,
    feeEarned: allFees,
    totalProfit,
    avgMonthlyProfit: months === null ? null : totalProfit / months,
    expectedValue: winRate === null ? null : winRate * avg(wins.map((w) => w.pnl)) + (1 - winRate) * avg(losses.map((l) => l.pnl)),
  };
}

export type Group = "day" | "week" | "month";

/** UTC bucket start for a date: day, ISO week (Monday) or month. */
export function bucketOf(d: Date, g: Group): string {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  if (g === "month") return `${y}-${String(m + 1).padStart(2, "0")}-01`;
  const day = new Date(Date.UTC(y, m, d.getUTCDate()));
  if (g === "week") day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day.toISOString().slice(0, 10);
}

/**
 * Per day/week/month totals. Only KNOWN values are summed: a position closed without a known PnL is
 * counted in `missing`, never as 0. A bucket where every value is missing has value null ("Veri eksik").
 */
export function history(rows: Array<{ at: Date; value: number | null }>, g: Group): Array<{ bucket: string; value: number | null; count: number; missing: number }> {
  const m = new Map<string, { value: number; known: number; count: number; missing: number }>();
  for (const r of rows) {
    const k = bucketOf(r.at, g);
    const e = m.get(k) ?? { value: 0, known: 0, count: 0, missing: 0 };
    e.count += 1;
    if (r.value === null || !Number.isFinite(r.value)) e.missing += 1;
    else {
      e.value += r.value;
      e.known += 1;
    }
    m.set(k, e);
  }
  return [...m.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([bucket, e]) => ({ bucket, value: e.known ? e.value : null, count: e.count, missing: e.missing }));
}

/** Range bounds as % from the pool price, and whether the price is inside. */
export function rangeVsPrice(lower: number | null, upper: number | null, active: number | null, binStep: number | null) {
  if (lower === null || upper === null || active === null || !binStep) return null;
  const f = 1 + binStep / 10_000;
  return {
    lowerPct: (Math.pow(f, lower - active) - 1) * 100,
    upperPct: (Math.pow(f, upper + 1 - active) - 1) * 100,
    inRange: active >= lower && active <= upper,
    bins: upper - lower + 1,
  };
}

/**
 * Account totals for the panel. Only LIVE open positions count towards the wallet's net worth;
 * dry-run (simulated) positions are reported apart. Without a wallet balance (RPC failed) there is
 * no net worth: the caller shows the last good one with its time, or "Bakiye alınamadı".
 */
export function accountTotals(p: { sol: number | null; tokensValue: number; positions: Array<{ value: number | null; dryRun: boolean }> }) {
  const positionsValue = p.positions.filter((x) => !x.dryRun).reduce((s, x) => s + (x.value ?? 0), 0);
  const dryRunValue = p.positions.filter((x) => x.dryRun).reduce((s, x) => s + (x.value ?? 0), 0);
  const complete = p.sol !== null;
  return { positionsValue, dryRunValue, complete, netWorth: complete ? p.sol! + p.tokensValue + positionsValue : null };
}
