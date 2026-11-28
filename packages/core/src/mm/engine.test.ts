import { describe, expect, it } from "vitest";
import { mmDecide, mmDistance, mmPlace, mmWidth } from "./engine.js";
import { ShadowBook } from "./shadow.js";

describe("mmWidth: round(100 / binStep), at least 1", () => {
  it.each([
    [1, 100],
    [5, 20],
    [8, 13], // 12.5 rounds up, as BviQ does
    [10, 10],
    [15, 7],
    [16, 6],
    [20, 5],
    [25, 4],
    [30, 3],
    [50, 2],
    [80, 1],
    [100, 1],
    [300, 1],
  ])("bin step %i → %i bins", (bs, w) => expect(mmWidth(bs)).toBe(w));
});

describe("mmPlace", () => {
  it("SOL sits right below the active bin", () => {
    expect(mmPlace("sol", -570, 100)).toEqual({ lower: -571, upper: -571, side: "sol" });
    expect(mmPlace("sol", 192, 10)).toEqual({ lower: 182, upper: 191, side: "sol" });
  });
  it("token sits right above the active bin", () => {
    expect(mmPlace("token", 100, 20)).toEqual({ lower: 101, upper: 105, side: "token" });
  });
});

describe("mmDecide (real BviQ moves)", () => {
  it("JIMMY-SOL: position −572, active −570 → move SOL to −571", () => {
    const d = mmDecide({ lower: -572, upper: -572, side: "sol" }, -570, 80);
    expect(d).toEqual({ kind: "rebalance", distance: 2, next: { lower: -571, upper: -571, side: "sol" } });
  });
  it("holds at distance 1, either side", () => {
    expect(mmDecide({ lower: -572, upper: -572, side: "sol" }, -571, 80).kind).toBe("hold");
    expect(mmDecide({ lower: 10, upper: 14, side: "sol" }, 9, 20).kind).toBe("hold");
  });
  it("price fell through SOL bins → token above the new active bin", () => {
    const d = mmDecide({ lower: 182, upper: 191, side: "sol" }, 180, 10);
    expect(d).toEqual({ kind: "rebalance", distance: -2, next: { lower: 181, upper: 190, side: "token" } });
  });
  it("token position, price rose through it → SOL below", () => {
    const d = mmDecide({ lower: 101, upper: 105, side: "token" }, 108, 20);
    expect(d.kind === "rebalance" && d.next).toEqual({ lower: 103, upper: 107, side: "sol" });
  });
  it("big jumps still land next to the active bin", () => {
    const d = mmDecide({ lower: -10, upper: -10, side: "sol" }, -3, 100);
    expect(d.kind === "rebalance" && d.next).toEqual({ lower: -4, upper: -4, side: "sol" });
  });
  it("distance is signed and 0 inside", () => {
    expect(mmDistance({ lower: 0, upper: 4 }, 2)).toBe(0);
    expect(mmDistance({ lower: 0, upper: 4 }, 7)).toBe(3);
    expect(mmDistance({ lower: 0, upper: 4 }, -2)).toBe(-2);
  });
});

describe("ShadowBook", () => {
  const open = () => {
    const b = new ShadowBook();
    b.onOpen({ position: "P", pool: "L", binStep: 80, range: { lower: -572, upper: -572, side: "sol" }, t: 0 });
    return b;
  };

  it("scores an exact match and records our lag", () => {
    const b = open();
    expect(b.onTick("L", -571, 10)).toHaveLength(0);
    expect(b.onTick("L", -570, 12)).toHaveLength(1);
    const c = b.onLeaderRebalance({ position: "P", pool: "L", binStep: 80, t: 14, active: -570, old: { lower: -572, upper: -572 }, next: { lower: -571, upper: -571, side: "sol" } });
    expect(c.outcome).toBe("match");
    expect(c.lagSec).toBe(-2);
    expect(b.summary().matchPct).toBe(100);
  });

  it("same side, later bin → match_other_bin; we re-sync to the leader", () => {
    const b = open();
    b.onTick("L", -570, 12);
    const c = b.onLeaderRebalance({ position: "P", pool: "L", binStep: 80, t: 20, active: -569, old: { lower: -572, upper: -572 }, next: { lower: -570, upper: -570, side: "sol" } });
    expect(c.outcome).toBe("match_other_bin");
    expect(b.open[0]!.range).toEqual({ lower: -570, upper: -570, side: "sol" });
  });

  it("leader moved before we ever read the trigger → not_seen (speed, not rules)", () => {
    const b = open();
    b.onTick("L", -571, 3); // distance 1: hold
    const c = b.onLeaderRebalance({ position: "P", pool: "L", binStep: 80, t: 5, active: -570, old: { lower: -572, upper: -572 }, next: { lower: -571, upper: -571, side: "sol" } });
    expect(c.outcome).toBe("not_seen");
  });

  it("a trigger read only AFTER the leader's block does not count as seen", () => {
    const b = new ShadowBook(3);
    b.onOpen({ position: "P", pool: "L", binStep: 80, range: { lower: -572, upper: -572, side: "sol" }, t: 0 });
    b.onTick("L", -571, 3); // before the leader: distance 1
    b.onTick("L", -570, 7); // after the leader's block at t=5
    const c = b.onLeaderRebalance({ position: "P", pool: "L", binStep: 80, t: 5, active: -570, old: { lower: -572, upper: -572 }, next: { lower: -571, upper: -571, side: "sol" } });
    expect(c.outcome).toBe("not_seen");
  });

  it("we read the trigger distance but did not move → missed (rule gap)", () => {
    const b = new ShadowBook(3); // a stricter engine than the leader
    b.onOpen({ position: "P", pool: "L", binStep: 80, range: { lower: -572, upper: -572, side: "sol" }, t: 0 });
    b.onTick("L", -570, 3); // distance 2: our trigger is 3, hold
    b.onTick("L", -570, 9); // a later read, after the leader's block, must not hide the earlier one
    const c = b.onLeaderRebalance({ position: "P", pool: "L", binStep: 80, t: 5, active: -570, old: { lower: -572, upper: -572 }, next: { lower: -571, upper: -571, side: "sol" } });
    expect(c.outcome).toBe("missed");
  });

  it("our book held a different range than the leader's old range → desync, not missed", () => {
    // we think [-572, -572]; the leader's real old range is [-571, -571] (a range change we never saw)
    const b2 = open();
    b2.onTick("L", -573, 3); // distance −1 from ours: hold, but 2 from the leader's real [-571, -571]
    const c = b2.onLeaderRebalance({ position: "P", pool: "L", binStep: 80, t: 5, active: -573, old: { lower: -571, upper: -571 }, next: { lower: -572, upper: -572, side: "token" } });
    expect(c.outcome).toBe("desync");
    expect(c.ourRange).toEqual({ lower: -572, upper: -572 });
    expect(c.leader.old).toEqual({ lower: -571, upper: -571 });
    expect(b2.summary().desyncPct).toBe(100);
    expect(b2.summary().missedPct).toBe(0);
    expect(b2.open[0]!.range).toEqual({ lower: -572, upper: -572, side: "token" }); // re-synced
  });

  it("unknown position is adopted, not scored", () => {
    const b = new ShadowBook();
    const c = b.onLeaderRebalance({ position: "Q", pool: "L", binStep: 100, t: 5, active: 3, old: { lower: 0, upper: 0 }, next: { lower: 2, upper: 2, side: "sol" } });
    expect(c.outcome).toBe("adopted");
    expect(b.stats.compared).toBe(0);
    expect(b.has("Q")).toBe(true);
  });

  it("our moves the leader never made count as extra on close", () => {
    const b = open();
    b.onTick("L", -570, 12);
    b.onClose("P", 20);
    expect(b.stats.extra).toBe(1);
    expect(b.open).toHaveLength(0);
  });
});

describe("idle exit (55 min without a rebalance)", () => {
  const MIN = 60;
  const book = () => {
    const b = new ShadowBook();
    b.onOpen({ position: "P", pool: "L", binStep: 100, range: { lower: -2, upper: -2, side: "sol" }, t: 0 });
    return b;
  };
  it("fires at 55 min and matches a leader close within 5 min", () => {
    const b = book();
    expect(b.checkExits(54 * MIN)).toHaveLength(0);
    expect(b.checkExits(55 * MIN)).toHaveLength(1);
    expect(b.checkExits(56 * MIN)).toHaveLength(0); // once
    const r = b.onClose("P", 57 * MIN)!;
    expect(r.exit.outcome).toBe("exit_match");
    expect(r.exit.lagSec).toBe(-2 * MIN);
    expect(r.exit.leaderIdleMin).toBe(57);
  });
  it("a leader move resets the timer", () => {
    const b = book();
    b.onLeaderRebalance({ position: "P", pool: "L", binStep: 100, t: 30 * MIN, active: 1, old: { lower: -2, upper: -2 }, next: { lower: 0, upper: 0, side: "sol" } });
    expect(b.checkExits(60 * MIN)).toHaveLength(0);
    expect(b.checkExits(85 * MIN)).toHaveLength(1);
  });
  it("leader holding much longer than 55 min → exit_early", () => {
    const b = book();
    b.checkExits(55 * MIN);
    expect(b.onClose("P", 90 * MIN)!.exit.outcome).toBe("exit_early");
  });
  it("leader closing an active position → exit_other", () => {
    const b = book();
    expect(b.onClose("P", 10 * MIN)!.exit.outcome).toBe("exit_other");
    expect(b.summary().exitOtherPct).toBe(100);
  });
});

import { mmAddsAt, mmRangeAfter, mmTokensDeposited } from "./plan.js";

describe("mmAddsAt: putting holdings back next to the active bin", () => {
  it("SOL: y0 = y / w below the active bin", () => {
    const a = mmAddsAt(0n, 1_000_000_000n, 10, 192, 1);
    expect(a).toEqual([{ minDeltaId: -10, maxDeltaId: -1, x0: 0n, y0: 100_000_000n, deltaX: 0n, deltaY: 0n }]);
    expect(mmAddsAt(0n, 1_000_000_000n, 10, 192)[0]!.y0).toBe(99_900_000n); // default keeps 0.1% back
    expect(mmRangeAfter(a, 192)).toEqual({ lower: 182, upper: 191, side: "sol" });
  });
  it("token: spends (almost) all tokens, never more", () => {
    for (const [bs, active, x] of [[100, -570, 95_391_926_624n], [20, 682, 1_000_000_000n], [8, -6340, 7_000_000n], [10, 3059, 123_456_789_012n]] as const) {
      const a = mmAddsAt(x, 0n, bs, active, 1);
      const dep = mmTokensDeposited(a, bs, active);
      expect(dep).toBeLessThanOrEqual(Number(x));
      expect(dep / Number(x)).toBeGreaterThan(0.999); // integer x0 rounding leaves a sliver in the wallet (sold on close)
      expect(mmRangeAfter(a, active).side).toBe("token");
      expect(mmRangeAfter(a, active).lower).toBe(active + 1);
    }
  });
  it("matches a real BviQ token move: x0 ≈ xA × price, 1 bin", () => {
    // JIMMY-SOL style 1-bin move (bin step 80): BviQ deposited xA tokens with x0 ≈ xA·price(active+1)
    const bs = 80, active = -600, x = 1_000_000_000_000n;
    const [a] = mmAddsAt(x, 0n, bs, active, 1);
    const expected = Number(x) * Math.pow(1.008, active + 1);
    expect(Math.abs(Number(a!.x0) - expected) / expected).toBeLessThan(2e-6); // the 1e-6 safety haircut
  });
  it("mixed holdings: both sides", () => {
    const a = mmAddsAt(5_000n, 2_000n, 100, 0);
    expect(a).toHaveLength(2);
    expect(mmRangeAfter(a, 0)).toMatchObject({ lower: -1, upper: 1 });
  });
});

import { mmTiming } from "./shadow.js";

describe("shadow timing by slot (exact range ≠ on time)", () => {
  const open = () => {
    const b = new ShadowBook();
    b.onOpen({ position: "P", pool: "L", binStep: 80, range: { lower: -572, upper: -572, side: "sol" }, t: 0 });
    return b;
  };
  const leaderMove = (b: ShadowBook, slot: number | undefined) =>
    b.onLeaderRebalance({ position: "P", pool: "L", binStep: 80, t: 100, slot, active: -570, old: { lower: -572, upper: -572 }, next: { lower: -571, upper: -571, side: "sol" } });

  it("mmTiming", () => {
    expect(mmTiming(10, 11)).toBe("before");
    expect(mmTiming(11, 11)).toBe("same_slot");
    expect(mmTiming(12, 11)).toBe("after");
    expect(mmTiming(undefined, 11)).toBe("unknown");
    expect(mmTiming(10, undefined)).toBe("unknown");
  });

  it("early: decided on an observation from an earlier slot", () => {
    const b = open();
    b.onTick("L", -570, 99, 1000);
    const c = leaderMove(b, 1001);
    expect(c.outcome).toBe("match");
    expect(c.timing).toBe("before");
    expect(c.ours?.slot).toBe(1000);
    expect(b.summary().matchBeforePct).toBe(100);
  });

  it("late: same range, but we only saw it after the leader's slot → match, timing after", () => {
    const b = open();
    b.onTick("L", -570, 101, 1003);
    const c = leaderMove(b, 1001);
    expect(c.outcome).toBe("match");
    expect(c.timing).toBe("after");
    expect(b.summary().matchBeforePct).toBe(0);
    expect(b.summary().matchAfterPct).toBe(100);
  });

  it("same slot: order cannot be told → same_slot (not counted as on time)", () => {
    const b = open();
    b.onTick("L", -570, 100, 1001);
    const c = leaderMove(b, 1001);
    expect(c.timing).toBe("same_slot");
    expect(b.summary().matchSameSlotPct).toBe(100);
    expect(b.summary().matchBeforePct).toBe(0);
  });

  it("leader moves twice in a few slots, we decided both before it: two matches, not match + missed", () => {
    // Server case (DtJHCYzv, 08:16): our decisions at slots 100 and 103, leader txs at 101 and 104,
    // and the leader txs are only processed after both of our decisions.
    const b = open(); // [-572, -572] sol, bin step 80 → width 1
    expect(b.onTick("L", -570, 1, 100)).toHaveLength(1); // → [-571, -571]
    expect(b.onTick("L", -569, 2, 103)).toHaveLength(1); // → [-570, -570], from our predicted range
    const a1 = b.onLeaderRebalance({ position: "P", pool: "L", binStep: 80, t: 1, slot: 101, active: -570, old: { lower: -572, upper: -572 }, next: { lower: -571, upper: -571, side: "sol" } });
    const a2 = b.onLeaderRebalance({ position: "P", pool: "L", binStep: 80, t: 2, slot: 104, active: -569, old: { lower: -571, upper: -571 }, next: { lower: -570, upper: -570, side: "sol" } });
    expect([a1.outcome, a1.timing, a1.extra]).toEqual(["match", "before", 0]);
    expect([a2.outcome, a2.timing, a2.extra]).toEqual(["match", "before", 0]);
    expect(b.summary().missedPct).toBe(0);
  });

  it("carried decisions are dropped when our answer did not land where the leader did", () => {
    const b = open();
    b.onTick("L", -570, 1, 100); // → [-571, -571]
    b.onTick("L", -569, 2, 103); // → [-570, -570] (derived from [-571, -571])
    // the leader went elsewhere: our later decision was built on a range that never existed
    const c = b.onLeaderRebalance({ position: "P", pool: "L", binStep: 80, t: 1, slot: 101, active: -568, old: { lower: -572, upper: -572 }, next: { lower: -569, upper: -569, side: "sol" } });
    expect(c.outcome).toBe("match_other_bin");
    expect(c.extra).toBe(1);
    expect(b.open[0]!.range).toEqual({ lower: -569, upper: -569, side: "sol" });
    expect(b.open[0]!.pending).toHaveLength(0);
  });

  it("no slots (old records) → unknown", () => {
    const b = open();
    b.onTick("L", -570, 99);
    expect(leaderMove(b, 1001).timing).toBe("unknown");
  });

  it("not_seen vs missed uses slots when both sides have them", () => {
    // A trigger read in the leader's own slot does not count as seen before it.
    const b = new ShadowBook(3);
    b.onOpen({ position: "P", pool: "L", binStep: 80, range: { lower: -572, upper: -572, side: "sol" }, t: 0 });
    b.onTick("L", -570, 100, 1001); // distance 2, our trigger is 3 → hold; same slot as the leader
    expect(leaderMove(b, 1001).outcome).toBe("not_seen");
    const b2 = new ShadowBook(3);
    b2.onOpen({ position: "P", pool: "L", binStep: 80, range: { lower: -572, upper: -572, side: "sol" }, t: 0 });
    b2.onTick("L", -570, 100, 1000); // seen one slot earlier
    expect(leaderMove(b2, 1001).outcome).toBe("missed");
  });
});
