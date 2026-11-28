// Audit regressions (2a46516 review) for the live follow mode, on a simulated chain. Nothing is sent.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { LiveMm } from "../src/live.js";
import { serviceTick } from "../src/tick.js";
import { FakeChain, OWNER, TOKEN } from "./fakeChain.js";

const LOT = 100_000_000n;
const RESERVE = 150_000_000n;
const flush = async (n = 20) => { for (let i = 0; i < n; i++) await Promise.resolve(); await new Promise((r) => setImmediate(r)); };

let readSlot = 0;
function make(c: FakeChain, o: { dir?: string; maxPositions?: number } = {}) {
  const dir = o.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "mmaudit-"));
  const records: Array<Record<string, unknown>> = [];
  const mm = new LiveMm(c.builder() as never, c.sender() as never, new PublicKey(OWNER), {
    lotLamports: LOT, maxPositions: o.maxPositions ?? 3, reserveLamports: RESERVE, slippageBins: 0, priorityMicroLamports: 0, settleEveryMs: 0,
    stateFile: path.join(dir, "state.json"), killFile: path.join(dir, "STOP"), closeAllFile: path.join(dir, "CLOSE_ALL"),
  }, { info() {}, warn() {}, error() {}, debug() {} } as never, (_k, obj) => records.push(obj));
  (mm as unknown as { jupiter: unknown }).jupiter = c.jupiter();
  const kinds = () => records.map((r) => `${r.kind}${r.reason ? `:${r.reason}` : ""}`);
  const ours = () => [...(mm as unknown as { ours: Map<string, { position: string; range: { lower: number; upper: number }; closeRequested?: boolean }> }).ours.values()];
  const state = () => JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
  const tick = (now = Math.floor(Date.now() / 1000)) =>
    serviceTick({ book: { pools: () => [], onTick: () => [], checkExits: () => [] }, live: mm, watcher: null, readPools: async (pools) => new Map(pools.map((p) => [p, { activeId: c.active.get(p) ?? 0, slot: ++readSlot }] as const)), write: () => {} }, now);
  return { mm, dir, records, kinds, ours, state, tick };
}

async function openOne(c: FakeChain, m: ReturnType<typeof make>, lp = "L1") {
  await m.mm.onLeaderOpen({ leaderPosition: lp, pool: "P", t: Math.floor(Date.now() / 1000) });
  return m.ours().find((p) => p)!;
}

afterEach(() => vi.useRealTimers());

describe("B1 one action at a time per position", () => {
  it("a pending close blocks new rebalances (zero parallel sends)", async () => {
    const c = new FakeChain();
    const m = make(c);
    const p = await openOne(c, m);
    c.behaviours.close.push("pending");
    await m.mm.onLeaderClose("L1");
    m.mm.onTick("P", p.range.upper + 5); // far out of range: would rebalance
    await flush();
    expect(c.broadcasts.map((b) => b.kind)).toEqual(["open", "close"]);
    expect(c.maxParallelPerPosition).toBe(1);
  });

  it("a rebalance preparing for more than 30 s does not let a close run in parallel", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const c = new FakeChain();
    const m = make(c);
    const p = await openOne(c, m);
    c.holdNext("simulateWithdraw");
    m.mm.onTick("P", p.range.upper + 5);
    await flush();
    const closing = m.mm.onLeaderClose("L1");
    await vi.advanceTimersByTimeAsync(31_000);
    expect(c.broadcasts.map((b) => b.kind)).toEqual(["open"]); // nothing while the rebalance holds the position
    c.release("simulateWithdraw");
    await vi.advanceTimersByTimeAsync(1_000);
    await closing;
    await flush();
    // the close request wins: the rebalance is dropped before signing, then the close runs alone
    expect(c.broadcasts.filter((b) => b.position).map((b) => b.kind)).toEqual(["open", "close"]);
    expect(c.maxParallelPerPosition).toBe(1);
  });
});

describe("B2 sales count what actually sold", () => {
  async function closed(c: FakeChain, m: ReturnType<typeof make>) {
    await openOne(c, m);
    await m.mm.onLeaderClose("L1");
  }

  it("pool takes 400 of 1000: 400 recorded as sold, 600 still owed, sold later; sell_done only at zero", async () => {
    const c = new FakeChain();
    c.poolSwapCapacity = 400n;
    const m = make(c);
    (m.mm as unknown as { jupiter: unknown }).jupiter = { quoteToSol: async () => { throw new Error("no route"); }, buildSwap: async () => { throw new Error("x"); } };
    await closed(c, m);
    expect(m.state().sales[0]).toMatchObject({ amount: "1000", sold: "400" });
    expect(m.kinds()).not.toContain("sell_done");
    c.poolSwapCapacity = 10n ** 30n;
    await m.tick(Math.floor(Date.now() / 1000) + 3600);
    await m.tick(Math.floor(Date.now() / 1000) + 7200);
    expect(c.token(TOKEN)).toBe(0n);
    expect(m.kinds().at(-1)).toBe("sell_done");
    expect(m.state().sales).toHaveLength(0);
  });

  it("partial fill with its reply lost: the tx's real 400 is counted at once, 600 kept", async () => {
    const c = new FakeChain();
    c.poolSwapCapacity = 400n;
    const m = make(c);
    (m.mm as unknown as { jupiter: unknown }).jupiter = { quoteToSol: async () => { throw new Error("no route"); }, buildSwap: async () => { throw new Error("x"); } };
    c.behaviours.swap.push("lost");
    await closed(c, m);
    expect(m.state().sales[0]).toMatchObject({ amount: "1000", sold: "400" });
    expect(m.state().sales[0].inFlight).toBeUndefined();
  });

  it("partial fill landed, then a crash before the reply: after restart the real 400 is counted, then more is sold", async () => {
    const c = new FakeChain();
    c.poolSwapCapacity = 400n;
    const noJup = { quoteToSol: async () => { throw new Error("no route"); }, buildSwap: async () => { throw new Error("x"); } };
    const m = make(c);
    (m.mm as unknown as { jupiter: unknown }).jupiter = noJup;
    c.behaviours.swap.push("landed_hang");
    await openOne(c, m);
    void m.mm.onLeaderClose("L1");
    await flush(50);
    expect(m.state().sales[0]).toMatchObject({ amount: "1000", sold: "0" });
    expect(m.state().sales[0].inFlight.sigs).toHaveLength(1);
    const r = make(c, { dir: m.dir });
    (r.mm as unknown as { jupiter: unknown }).jupiter = noJup;
    await r.tick();
    // 400 recovered from the landed tx + 400 sold now: 800, never "1000 sold"
    expect(r.state().sales[0]).toMatchObject({ amount: "1000", sold: "800" });
    expect(c.token(TOKEN)).toBe(200n);
  });

  it("a single zero-balance answer while 1000 is owed does not finish the sale", async () => {
    const c = new FakeChain();
    const m = make(c);
    await openOne(c, m);
    c.balanceGlitches.push("zero");
    await m.mm.onLeaderClose("L1");
    expect(m.kinds()).not.toContain("sell_done");
    expect(m.state().sales[0]).toMatchObject({ amount: "1000", sold: "0" });
    await m.tick(Math.floor(Date.now() / 1000) + 3600);
    await m.tick(Math.floor(Date.now() / 1000) + 7200);
    expect(c.token(TOKEN)).toBe(0n);
    expect(m.kinds().at(-1)).toBe("sell_done");
  });
});

describe("B5 ranges and budget follow the chain", () => {
  it("SDK clips the open range: we record the range the chain has", async () => {
    const c = new FakeChain();
    c.binStep = 20; // width 5: [-5, -1] planned at active 0
    const m = make(c);
    c.holdNext("open");
    const opening = m.mm.onLeaderOpen({ leaderPosition: "L1", pool: "P", t: Math.floor(Date.now() / 1000) });
    await flush();
    c.active.set("P", -3); // price moved while the open was being built: the SDK clips to [-5, -3]
    c.release("open");
    await opening;
    const p = m.ours()[0]!;
    const acct = c.accounts.get(p.position)!;
    expect({ lower: p.range.lower, upper: p.range.upper }).toEqual({ lower: acct.lower, upper: acct.upper });
  });

  it("SDK builds the rebalance against an active bin one off from our plan: our range is the chain's", async () => {
    const c = new FakeChain();
    const m = make(c);
    const p0 = await openOne(c, m);
    const planned = p0.range.upper + 5;
    c.active.set("P", planned + 1); // the SDK refetches and sees one bin further
    m.mm.onTick("P", planned);
    await flush();
    const p = m.ours()[0]!;
    const acct = c.accounts.get(p.position)!;
    expect({ lower: p.range.lower, upper: p.range.upper }).toEqual({ lower: acct.lower, upper: acct.upper });
  });

  it("restart re-reads every position's range from chain", async () => {
    const c = new FakeChain();
    const m = make(c);
    const p = await openOne(c, m);
    c.accounts.get(p.position)!.lower -= 3; // the chain says otherwise than our state file
    const r = make(c, { dir: m.dir });
    await r.tick();
    expect(r.ours()[0]!.range.lower).toBe(c.accounts.get(p.position)!.lower);
  });

  it("balance exactly lot + reserve: the open is refused (fees + rent would dip into the reserve)", async () => {
    const c = new FakeChain();
    c.sol = LOT + RESERVE;
    const m = make(c);
    await m.mm.onLeaderOpen({ leaderPosition: "L1", pool: "P", t: Math.floor(Date.now() / 1000) });
    expect(m.kinds()).toEqual(["open_skipped:low_balance"]);
    expect(c.sol).toBe(LOT + RESERVE);
  });
});

describe("recovery and budget", () => {
  it("an older state file (string signatures everywhere) recovers close → sale end to end", async () => {
    const c = new FakeChain();
    const m = make(c);
    const p = await openOne(c, m);
    // the close landed before a crash; the old format stored bare strings
    c.behaviours.close.push("pending");
    await m.mm.onLeaderClose("L1");
    const sig = c.sigsOf("close")[0]!;
    c.land(sig);
    const st = m.state();
    st.positions[0].closeSigs = st.positions[0].closeSigs.map((x: { sig: string }) => x.sig);
    fs.writeFileSync(path.join(m.dir, "state.json"), JSON.stringify(st));
    const r = make(c, { dir: m.dir });
    await r.tick();
    await r.tick(Math.floor(Date.now() / 1000) + 60);
    expect(r.kinds()).toContain("close_verified:leader_closed");
    expect(r.kinds().at(-1)).toBe("sell_done");
    expect(c.token(TOKEN)).toBe(0n);
    expect(p.position).toBeTruthy();
  });

  it("three concurrent opens with money for two: exactly two open; a failed preparation frees its budget", async () => {
    const c = new FakeChain();
    // each open spends lot + 0.06 SOL (rent/fees) in the fake: room for exactly two above the reserve
    c.sol = RESERVE + 2n * (LOT + 60_000_000n) + 1n;
    const m = make(c, { maxPositions: 5 });
    c.holdNext("poolInfo");
    const t = Math.floor(Date.now() / 1000);
    const all = ["L1", "L2", "L3"].map((lp) => m.mm.onLeaderOpen({ leaderPosition: lp, pool: "P", t }));
    await flush();
    c.release("poolInfo");
    await Promise.all(all);
    expect(c.broadcasts.filter((b) => b.kind === "open")).toHaveLength(2);
    expect(m.kinds().filter((k) => k === "open_skipped:low_balance")).toHaveLength(1);
  });

  it("a failed preparation releases its reservation", async () => {
    const c = new FakeChain();
    c.sol = RESERVE + (LOT + 60_000_000n) + 1n; // room for one
    const m = make(c);
    c.behaviours.open.push("fail");
    await m.mm.onLeaderOpen({ leaderPosition: "L1", pool: "P", t: Math.floor(Date.now() / 1000) });
    await m.mm.onLeaderOpen({ leaderPosition: "L2", pool: "P", t: Math.floor(Date.now() / 1000) });
    expect(c.broadcasts.filter((b) => b.kind === "open")).toHaveLength(2);
    expect(m.ours()).toHaveLength(1);
  });

  it("restart with an unresolved open: its simulated spend (not just the lot) stays reserved; an open that would dip into the reserve is refused", async () => {
    const c = new FakeChain();
    // room for exactly ONE open (lot + 0.06 SOL rent/fees) above the reserve, plus a lot: the old
    // restart accounting reserved only the lot and let a second open through
    c.sol = RESERVE + 2n * LOT + 60_000_000n + 1n;
    const m = make(c);
    c.behaviours.open.push("hang"); // signed and broadcast, then the process dies (never landed)
    void m.mm.onLeaderOpen({ leaderPosition: "L1", pool: "P", t: Math.floor(Date.now() / 1000) });
    await flush(50);
    expect(m.state().opening[0]).toMatchObject({ leaderPosition: "L1", spend: String(LOT + 60_000_000n) });
    const r = make(c, { dir: m.dir });
    await r.mm.onLeaderOpen({ leaderPosition: "L2", pool: "P", t: Math.floor(Date.now() / 1000) });
    expect(r.kinds()).toEqual(["open_skipped:low_balance"]);
    expect(c.broadcasts.filter((b) => b.kind === "open")).toHaveLength(1);
  });
});

