import { describe, expect, it } from "vitest";
import { leaderStats, type LeaderMove } from "./leaderStats.js";

const t = (min: number) => new Date(Date.UTC(2026, 10, 23, 12, 0) + min * 60_000);
const m = (kind: LeaderMove["kind"], position: string, pool: string, min: number): LeaderMove => ({ kind, position, pool, at: t(min) });

describe("leaderStats (LP Agent dialog)", () => {
  it("average hold and the 18-minute high-frequency warning", () => {
    const s = leaderStats([m("open", "a", "P", 0), m("close", "a", "P", 10), m("open", "b", "Q", 0), m("close", "b", "Q", 20)]);
    expect(s).toMatchObject({ avgHoldMinutes: 15, closedSample: 2, highFrequency: true });
    expect(leaderStats([m("open", "a", "P", 0), m("close", "a", "P", 60)]).highFrequency).toBe(false);
  });

  it("re-adds of the same pool within 1 and 5 minutes of an exit", () => {
    const s = leaderStats([
      m("open", "a", "P", 0),
      m("close", "a", "P", 30),
      m("open", "b", "P", 30.5), // re-added within a minute
      m("close", "b", "P", 60),
      m("open", "c", "P", 63), // within 5 minutes
      m("close", "c", "P", 120), // never re-added
    ]);
    expect(s.exitSample).toBe(3);
    expect(s.reAdd1mPct).toBeCloseTo(33.33, 1);
    expect(s.reAdd5mPct).toBeCloseTo(66.67, 1);
  });

  it("no data → no warning", () => {
    expect(leaderStats([])).toMatchObject({ avgHoldMinutes: null, highFrequency: false, reAdd1mPct: null });
  });
});
