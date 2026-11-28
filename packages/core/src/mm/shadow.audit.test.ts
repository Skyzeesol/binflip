// Audit (2a46516) shadow scoring regressions.
import { describe, expect, it } from "vitest";
import { ShadowBook } from "./shadow.js";

const move = (b: ShadowBook, slot: number, t: number, old: [number, number], next: [number, number], active: number) =>
  b.onLeaderRebalance({ position: "P", pool: "L", binStep: 80, t, slot, active, old: { lower: old[0], upper: old[1] }, next: { lower: next[0], upper: next[1], side: "sol" } });

describe("shadow scoring (audit)", () => {
  it("a pool read taken before the position was opened is not a 'missed' for it", () => {
    const b = new ShadowBook();
    b.onTick("L", -570, 90, 490); // the pool was read for another reason, before P existed
    b.onOpen({ position: "P", pool: "L", binStep: 80, range: { lower: -572, upper: -572, side: "sol" }, t: 100, slot: 500 });
    const c = move(b, 510, 102, [-572, -572], [-571, -571], -570);
    expect(c.outcome).toBe("not_seen");
  });

  it("a decision derived from a dropped intermediate decision is not carried", () => {
    const b = new ShadowBook();
    b.onOpen({ position: "P", pool: "L", binStep: 80, range: { lower: -572, upper: -572, side: "sol" }, t: 0, slot: 1 });
    b.onTick("L", -570, 1, 100); // d1 → [-571]
    b.onTick("L", -568, 2, 102); // d2 from [-571] → [-569]  (before the leader's slot: an extra)
    b.onTick("L", -566, 3, 105); // d3 from [-569] → [-567]  (after the leader's slot, but built on d2)
    const c = move(b, 103, 2, [-572, -572], [-571, -571], -570);
    expect(c.outcome).toBe("match");
    expect(b.open[0]!.pending).toHaveLength(0); // d3's source range never existed for the leader
    expect(b.open[0]!.range).toMatchObject({ lower: -571, upper: -571 });
  });

  it("an idle exit predicted 15 min after the leader's close is late, not a match", () => {
    const b = new ShadowBook();
    b.onOpen({ position: "P", pool: "L", binStep: 80, range: { lower: -572, upper: -572, side: "sol" }, t: 0 });
    b.checkExits(55 * 60 + 900); // our rule fires at 4200 s
    const r = b.onClose("P", 55 * 60); // the leader closed at 3300 s
    expect(r!.exit.outcome).toBe("exit_late");
    expect(b.summary().exitMatchPct).toBe(0);
  });

  it("'before' by slot but decided after the leader's block is reported apart", () => {
    const b = new ShadowBook();
    b.onOpen({ position: "P", pool: "L", binStep: 80, range: { lower: -572, upper: -572, side: "sol" }, t: 0, slot: 1 });
    b.onTick("L", -570, 110, 100); // an old observation (slot 100) that reached us at t = 110
    const c = move(b, 101, 105, [-572, -572], [-571, -571], -570);
    expect(c.timing).toBe("before");
    expect(c.decidedAfterLeaderBlock).toBe(true);
    expect(b.summary().beforeButLatePct).toBe(100);
  });
});
