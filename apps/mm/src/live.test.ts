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

type SendMode = "ok" | "land_then_throw" | "land_then_hang" | "fail";
function setup(o: { maxPositions?: number; balanceSol?: number; dir?: string; chain?: Set<string> } = {}) {
  const dir = o.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "mmlive-"));
  const chain = o.chain ?? new Set<string>(); // position accounts that exist "on chain"
  const sigStatus = new Map<string, "confirmed" | "failed" | "unknown">();
  let sendMode: SendMode = "ok";
  const calls = { poolInfo: 0, open: 0, send: 0, remove: 0 };
  const gates = { poolInfo: [] as ReturnType<typeof gate>[], send: [] as ReturnType<typeof gate>[] };
  let hold = { poolInfo: false, send: false };
  const builder = {
    connection: {
      getBalance: async () => Math.round((o.balanceSol ?? 10) * 1e9),
      getAccountInfo: async (pk: PublicKey) => (chain.has(pk.toBase58()) ? { data: Buffer.alloc(0) } : null),
    },
    async poolInfo() {
      calls.poolInfo++;
      if (hold.poolInfo) { const g = gate(); gates.poolInfo.push(g); await g.p; }
      return { solIsY: true, binStep: 100, activeBinId: 0, mintX: "So11111111111111111111111111111111111111112" };
    },
    async open() { calls.open++; return { txs: [{}], extraSigners: new Map(), position: posAddr(calls.open) }; },
    async remove() { calls.remove++; return { txs: [{}], extraSigners: new Map() }; },
    async tokenBalance() { return 0n; },
  };
  const sender = {
    async send(_tx: unknown, _x: unknown, opts: { onSignature?: (s: string) => Promise<void> } = {}) {
      calls.send++;
      const sig = `sig${calls.send}`;
      await opts.onSignature?.(sig);
      if (hold.send) { const g = gate(); gates.send.push(g); await g.p; }
      const mode = sendMode;
      if (mode === "fail") { sigStatus.set(sig, "failed"); throw new Error("simulation failed"); }
      chain.add(posAddr(calls.open)); // the open landed
      sigStatus.set(sig, "confirmed");
      if (mode === "land_then_throw") throw new Error("fetch failed (reply lost)");
      if (mode === "land_then_hang") await new Promise(() => {}); // process "crashes" here
      return { signature: sig };
    },
    async status(sig: string) { return sigStatus.get(sig) ?? "unknown"; },
  };
  const records: Record<string, unknown>[] = [];
  const log = { info() {}, warn() {}, error() {}, debug() {} };
  const mm = new LiveMm(builder as never, sender as never, new PublicKey("11111111111111111111111111111111"), {
    lotLamports: 100_000_000n, maxPositions: o.maxPositions ?? 3, reserveLamports: 150_000_000n, slippageBins: 0,
    priorityMicroLamports: 0, stateFile: path.join(dir, "state.json"), killFile: path.join(dir, "STOP"), closeAllFile: path.join(dir, "CLOSE_ALL"),
  }, log as never, (kind, obj) => records.push({ _file: kind, ...obj }));
  return { mm, dir, chain, calls, gates, records, holdAll: (h: Partial<typeof hold>) => (hold = { ...hold, ...h }), sendMode: (m: SendMode) => (sendMode = m) };
}
// distinct valid base58 public keys for fake position accounts
const posAddr = (n: number) => new PublicKey(new Uint8Array(32).fill(n % 255 + 1)).toBase58();
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

  it("open landed but the RPC reply was lost: position is adopted from chain, not forgotten", async () => {
    const s = setup();
    s.sendMode("land_then_throw");
    await s.mm.onLeaderOpen({ leaderPosition: "L1", pool: "P", t: 0 });
    expect(s.mm.openCount).toBe(1);
    expect(kinds(s.records)).toEqual(["open_uncertain", "open"]);
  });

  it("crash after broadcast: a restart restores the position (and a pending leader close) from the state file", async () => {
    const s = setup();
    s.sendMode("land_then_hang");
    void s.mm.onLeaderOpen({ leaderPosition: "L1", pool: "P", t: 0 });
    for (let i = 0; i < 10 && s.calls.send === 0; i++) await tick();
    await tick();
    await s.mm.onLeaderClose("L1"); // close intent while the open is in flight: must be persisted
    const state = JSON.parse(fs.readFileSync(path.join(s.dir, "state.json"), "utf8"));
    expect(state.opening).toHaveLength(1);
    expect(state.opening[0]).toMatchObject({ leaderPosition: "L1", position: posAddr(1), sigs: ["sig1"], closeRequested: true });
    // "restart": new instance on the same state file and chain
    const r = setup({ dir: s.dir, chain: s.chain });
    expect(r.mm.openCount).toBe(1); // counted against the limit before it is resolved
    await r.mm.checkIdle(Math.floor(Date.now() / 1000));
    expect(kinds(r.records)).toEqual(["open_recovered", "close:leader_closed"]);
    expect(r.calls.remove).toBe(1);
    expect(r.mm.openCount).toBe(0);
  });

  it("broadcast that never landed (tx failed) is dropped, not adopted", async () => {
    const s = setup();
    s.sendMode("fail");
    await s.mm.onLeaderOpen({ leaderPosition: "L1", pool: "P", t: 0 });
    expect(s.mm.openCount).toBe(0);
    expect(kinds(s.records)).toEqual(["open_uncertain", "open_dropped:tx_failed"]);
  });

  it("STOP created while the open waits on RPC: nothing is sent", async () => {
    const s = setup();
    s.holdAll({ poolInfo: true });
    const a = s.mm.onLeaderOpen({ leaderPosition: "L1", pool: "P", t: 0 });
    await tick();
    fs.writeFileSync(path.join(s.dir, "STOP"), "");
    s.gates.poolInfo.forEach((g) => g.open());
    await a;
    expect(s.calls.send).toBe(0);
    expect(s.mm.openCount).toBe(0);
    expect(kinds(s.records)).toEqual(["open_skipped:kill_file_before_send"]);
  });

  it("CLOSE_ALL created while the open waits on RPC: nothing is sent", async () => {
    const s = setup();
    s.holdAll({ poolInfo: true });
    const a = s.mm.onLeaderOpen({ leaderPosition: "L1", pool: "P", t: 0 });
    await tick();
    fs.writeFileSync(path.join(s.dir, "CLOSE_ALL"), "");
    s.gates.poolInfo.forEach((g) => g.open());
    await a;
    expect(s.calls.send).toBe(0);
  });
});
