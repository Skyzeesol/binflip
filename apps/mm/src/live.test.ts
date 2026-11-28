import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { LiveMm } from "./live.js";

// Fakes: no RPC, no signing, no sending. Each async builder call can be held on a gate so the
// tests control interleaving exactly.
function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

function setup(o: { maxPositions?: number; balanceSol?: number } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmlive-"));
  const calls = { poolInfo: 0, open: 0, send: 0, remove: 0 };
  const gates = { poolInfo: [] as ReturnType<typeof gate>[], send: [] as ReturnType<typeof gate>[] };
  let hold = { poolInfo: false, send: false };
  const builder = {
    connection: { getBalance: async () => Math.round((o.balanceSol ?? 10) * 1e9) },
    async poolInfo() {
      calls.poolInfo++;
      if (hold.poolInfo) { const g = gate(); gates.poolInfo.push(g); await g.p; }
      return { solIsY: true, binStep: 100, activeBinId: 0, mintX: "So11111111111111111111111111111111111111112" };
    },
    async open() { calls.open++; return { txs: [{}], extraSigners: new Map(), position: `pos${calls.open}` }; },
    async remove() { calls.remove++; return { txs: [{}], extraSigners: new Map() }; },
    async tokenBalance() { return 0n; },
  };
  const sender = {
    async send() {
      calls.send++;
      if (hold.send) { const g = gate(); gates.send.push(g); await g.p; }
      return { signature: `sig${calls.send}` };
    },
  };
  const records: Record<string, unknown>[] = [];
  const log = { info() {}, warn() {}, error() {}, debug() {} };
  const mm = new LiveMm(builder as never, sender as never, new PublicKey("11111111111111111111111111111111"), {
    lotLamports: 100_000_000n, maxPositions: o.maxPositions ?? 3, reserveLamports: 150_000_000n, slippageBins: 0,
    priorityMicroLamports: 0, stateFile: path.join(dir, "state.json"), killFile: path.join(dir, "STOP"), closeAllFile: path.join(dir, "CLOSE_ALL"),
  }, log as never, (kind, obj) => records.push({ _file: kind, ...obj }));
  return { mm, calls, gates, records, holdAll: (h: Partial<typeof hold>) => (hold = { ...hold, ...h }) };
}
const kinds = (r: Record<string, unknown>[]) => r.map((x) => `${x.kind}${x.reason ? `:${x.reason}` : ""}`);

describe("LiveMm open/close races (no RPC, nothing sent)", () => {
  it("two concurrent leader opens with maxPositions=1 open only one", async () => {
    const s = setup({ maxPositions: 1 });
    s.holdAll({ poolInfo: true });
    const a = s.mm.onLeaderOpen({ leaderPosition: "L1", pool: "P", t: 0 });
    const b = s.mm.onLeaderOpen({ leaderPosition: "L2", pool: "P", t: 0 });
    await tick();
    s.gates.poolInfo.forEach((g) => g.open());
    await Promise.all([a, b]);
    expect(s.calls.open).toBe(1);
    expect(s.calls.poolInfo).toBe(1); // the second was refused before any RPC call
    expect(s.mm.openCount).toBe(1);
    expect(kinds(s.records)).toEqual(["open_skipped:max_positions", "open"]);
  });

  it("a duplicate open signal for the same leader position opens once", async () => {
    const s = setup();
    s.holdAll({ poolInfo: true });
    const a = s.mm.onLeaderOpen({ leaderPosition: "L1", pool: "P", t: 0 });
    const b = s.mm.onLeaderOpen({ leaderPosition: "L1", pool: "P", t: 0 });
    await tick();
    s.gates.poolInfo.forEach((g) => g.open());
    await Promise.all([a, b]);
    await s.mm.onLeaderOpen({ leaderPosition: "L1", pool: "P", t: 0 }); // after it landed, too
    expect(s.calls.open).toBe(1);
    expect(s.mm.openCount).toBe(1);
  });

  it("SOL budget counts the lots of opens still in flight", async () => {
    // 0.35 SOL = reserve 0.15 + 2 lots of 0.1: the third concurrent open must be refused.
    const s = setup({ balanceSol: 0.35, maxPositions: 5 });
    s.holdAll({ poolInfo: true });
    const ps = ["L1", "L2", "L3"].map((l) => s.mm.onLeaderOpen({ leaderPosition: l, pool: "P", t: 0 }));
    await tick();
    s.gates.poolInfo.forEach((g) => g.open());
    await Promise.all(ps);
    expect(s.calls.open).toBeLessThanOrEqual(2);
    expect(kinds(s.records)).toContain("open_skipped:low_balance");
  });

  it("leader close before our open is sent cancels the open (nothing signed)", async () => {
    const s = setup();
    s.holdAll({ poolInfo: true });
    const a = s.mm.onLeaderOpen({ leaderPosition: "L1", pool: "P", t: 0 });
    await tick();
    await s.mm.onLeaderClose("L1");
    s.gates.poolInfo.forEach((g) => g.open());
    await a;
    expect(s.calls.send).toBe(0);
    expect(s.mm.openCount).toBe(0);
    expect(kinds(s.records)).toEqual(["close_deferred:leader_closed", "open_skipped:leader_closed_before_open"]);
  });

  it("leader close while our open is being sent closes it once it lands", async () => {
    const s = setup();
    s.holdAll({ send: true });
    const a = s.mm.onLeaderOpen({ leaderPosition: "L1", pool: "P", t: 0 });
    for (let i = 0; i < 5 && !s.gates.send.length; i++) await tick();
    expect(s.gates.send.length).toBe(1); // open tx is "in flight"
    await s.mm.onLeaderClose("L1");
    s.holdAll({ send: false });
    s.gates.send.forEach((g) => g.open());
    await a;
    expect(s.calls.remove).toBe(1);
    expect(s.mm.openCount).toBe(0);
    expect(kinds(s.records)).toEqual(["close_deferred:leader_closed", "open", "close:leader_closed"]);
  });
});
