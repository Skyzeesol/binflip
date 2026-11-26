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
    b.onClose("P");
    expect(b.stats.extra).toBe(1);
    expect(b.open).toHaveLength(0);
  });
});
