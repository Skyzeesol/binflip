// Audit B3 (leader feed) and B4 (strict opens, stale observations). Fakes only, nothing sent.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LeaderFeed, type SigInfo } from "../src/leaderFeed.js";
import { leaderEvents, liveOpenAllowed } from "../src/leaderEvents.js";
import { SlotGate } from "../src/slotGate.js";
import { serviceTick } from "../src/tick.js";

const LEADER = "Leader1111111111111111111111111111111111111";

/** A leader history on a fake RPC: signatures newest first, like getSignaturesForAddress. */
class FakeHistory {
  sigs: SigInfo[] = []; // oldest first internally
  unreadable = new Set<string>();
  throwOn = new Set<string>(); // getTransaction throws (RPC error)
  push(n: number, tag = "tx") {
    for (let i = 0; i < n; i++) {
      const slot = 1000 + this.sigs.length;
      this.sigs.push({ signature: `${tag}${this.sigs.length}`, slot, err: null, blockTime: slot });
    }
  }
  rpc() {
    return {
      getSignaturesForAddress: async (_a: string, o: { limit: number; before?: string; until?: string }) => {
        let list = [...this.sigs].reverse(); // newest first
        if (o.before) list = list.slice(list.findIndex((s) => s.signature === o.before) + 1);
        if (o.until) { const i = list.findIndex((s) => s.signature === o.until); if (i >= 0) list = list.slice(0, i); }
        return list.slice(0, o.limit);
      },
      getTransaction: async (sig: string) => {
        if (this.throwOn.has(sig)) throw new Error("503");
        const s = this.sigs.find((x) => x.signature === sig)!;
        return { meta: this.unreadable.has(sig) ? null : {}, slot: s.slot, blockTime: s.blockTime, sig };
      },
    };
  }
}

describe("B3 leader feed: downtime, >200 events, a broken tx and replay, in one run", () => {
  it("sees every leader tx exactly in order; the broken one is retried late, never blocking", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feed-"));
    const file = path.join(dir, "feed.json");
    const h = new FakeHistory();
    h.push(5, "old"); // before we ever started
    const handled: Array<{ sig: string; late: boolean }> = [];
    const mk = (crashOn?: string) =>
      new LeaderFeed(h.rpc(), LEADER, file, async (tx, info) => {
        handled.push({ sig: info.signature, late: info.late });
        if (info.signature === crashOn) throw new Error("process crash after handling, before saving progress");
      }, { pageSize: 50, maxTries: 3, onUnreadable: (s) => unreadable.push(s) });
    const unreadable: string[] = [];

    // first start: from "now"
    let f = mk();
    await f.poll();
    expect(handled).toEqual([]);
    // downtime: 220 leader txs (incl. a close at #7 and one with meta null at #10) while we are down
    h.push(220);
    const closeSig = h.sigs[5 + 7]!.signature;
    const broken = h.sigs[5 + 10]!.signature;
    h.unreadable.add(broken);
    // restart from the persisted cursor; a crash right after handling tx #30 (before progress saved)
    const crashSig = h.sigs[5 + 30]!.signature;
    f = mk(crashSig);
    await expect(f.poll()).rejects.toThrow("process crash");
    // restart again: replays #30 (at-least-once), continues to the end
    f = mk();
    await f.poll();
    const inOrder = handled.filter((x) => !x.late).map((x) => x.sig);
    const expected = h.sigs.slice(5).map((s) => s.signature).filter((s) => s !== broken);
    expect([...new Set(inOrder)]).toEqual(expected); // nothing lost, in order, the close included
    expect(inOrder).toContain(closeSig);
    expect(inOrder.filter((s) => s === crashSig)).toHaveLength(2); // replayed once: handlers must be idempotent
    expect(inOrder.length).toBe(expected.length + 1);
    // the broken tx becomes readable: handled late (live opens are not allowed for late txs)
    h.unreadable.delete(broken);
    await f.poll();
    expect(handled.at(-1)).toEqual({ sig: broken, late: true });
    expect(f.state.retry).toHaveLength(0);
  });

  it("a tx that never becomes readable is reported after maxTries, and stops being retried", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feed-"));
    const h = new FakeHistory();
    h.push(1);
    const unreadable: string[] = [];
    const f = new LeaderFeed(h.rpc(), LEADER, path.join(dir, "f.json"), async () => {}, { maxTries: 3, onUnreadable: (s) => unreadable.push(s) });
    await f.poll();
    h.push(3);
    h.unreadable.add(h.sigs[2]!.signature);
    for (let i = 0; i < 4; i++) await f.poll();
    expect(unreadable).toEqual([h.sigs[2]!.signature]);
    expect(f.state.retry).toHaveLength(0);
  });

  it("an RPC error on getTransaction keeps the cursor: the tx is read on the next poll", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feed-"));
    const h = new FakeHistory();
    h.push(1);
    const seen: string[] = [];
    const f = new LeaderFeed(h.rpc(), LEADER, path.join(dir, "f.json"), async (_tx, i) => { seen.push(i.signature); }, {});
    await f.poll();
    h.push(2);
    h.throwOn.add(h.sigs[1]!.signature);
    await expect(f.poll()).rejects.toThrow("503");
    h.throwOn.clear();
    await f.poll();
    expect(seen).toEqual([h.sigs[1]!.signature, h.sigs[2]!.signature]);
  });
});

// synthetic decodes
const init = (position: string, pool: string, owner: string, name = "initialize_position2") =>
  ({ protocol: "dlmm", kind: "ix", name, accounts: { position, lb_pair: pool, owner, payer: owner }, args: { lower_bin_id: -5, width: 5 } }) as never;
const add = (position: string, pool: string, x: number, y: number) => ({ protocol: "dlmm", kind: "event", name: "AddLiquidity", data: { position, lb_pair: pool, amounts: [x, y], active_bin_id: 0 } }) as never;

describe("B4 strict open matching", () => {
  it("another owner's position is not an open of the leader", () => {
    expect(leaderEvents([init("P1", "POOL", "SomeoneElse"), add("P1", "POOL", 0, 1e9)], LEADER)).toEqual([]);
  });
  it("empty and two-sided opens are not SOL opens; funding of another position does not count", () => {
    const evs = leaderEvents([init("P1", "POOL", LEADER), init("P2", "POOL", LEADER), add("P2", "POOL", 500, 1e9), add("OTHER", "POOL", 0, 1e9)], LEADER);
    expect(evs.map((e) => e.kind === "open" && [e.position, e.side])).toEqual([["P1", "empty"], ["P2", "two_sided"]]);
    for (const e of evs) if (e.kind === "open") expect(liveOpenAllowed(e, 1000, 1001, false)).toBe(false);
  });
  it("every valid open of a tx is returned (not only the first)", () => {
    const evs = leaderEvents([init("P1", "POOL", LEADER), add("P1", "POOL", 0, 1e9), init("P2", "POOL2", LEADER), add("P2", "POOL2", 0, 2e9)], LEADER);
    expect(evs.filter((e) => e.kind === "open").map((e) => e.kind === "open" && [e.position, e.side])).toEqual([["P1", "sol"], ["P2", "sol"]]);
  });
  it("funding in another pool for the same position id is ignored", () => {
    const [e] = leaderEvents([init("P1", "POOL", LEADER), add("P1", "ELSEWHERE", 0, 1e9)], LEADER);
    expect(e).toMatchObject({ kind: "open", side: "empty" });
  });
  it("a live open needs a known, recent block time and an in-order tx", () => {
    const [e] = leaderEvents([init("P1", "POOL", LEADER), add("P1", "POOL", 0, 1e9)], LEADER) as never as [Parameters<typeof liveOpenAllowed>[0]];
    expect(liveOpenAllowed(e, 1000, 1010, false)).toBe(true);
    expect(liveOpenAllowed(e, undefined, 1010, false)).toBe(false); // age unknown
    expect(liveOpenAllowed(e, 1000, 1200, false)).toBe(false); // too old
    expect(liveOpenAllowed(e, 1000, 1010, true)).toBe(false); // late retry
  });
});

describe("B4 stale observations", () => {
  it("an RPC read at slot 98 after a WebSocket update at slot 101 is dropped", async () => {
    const gate = new SlotGate();
    expect(gate.accept("POOL", 101)).toBe(true); // WS
    const seen: Array<[string, number]> = [];
    const live = { pools: () => ["POOL"], onTick: (p: string, a: number) => seen.push([p, a]), checkIdle: async () => {} };
    await serviceTick({ book: { pools: () => [], onTick: () => [], checkExits: () => [] }, live, watcher: null, write: () => {}, gate, readPools: async () => new Map([["POOL", { activeId: 7, slot: 98 }]]) });
    expect(seen).toEqual([]);
    await serviceTick({ book: { pools: () => [], onTick: () => [], checkExits: () => [] }, live, watcher: null, write: () => {}, gate, readPools: async () => new Map([["POOL", { activeId: 8, slot: 102 }]]) });
    expect(seen).toEqual([["POOL", 8]]);
  });
  it("an observation without a slot cannot be ordered: dropped", () => {
    expect(new SlotGate().accept("POOL", undefined)).toBe(false);
  });
});
