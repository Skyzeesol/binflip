import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { LiveMm } from "./live.js";
import { serviceTick } from "./tick.js";

// Fakes: no RPC, no signing, no sending. Each async builder call can be held on a gate so the
// tests control interleaving exactly.
function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

type SendMode = "ok" | "land_then_throw" | "land_then_hang" | "fail";
const TOKEN = "TokenMint1111111111111111111111111111111111";
type Wallet = { tokens: bigint; balanceReadFailures: number };
/** Shared "chain clock": block height, advanced by tests to expire blockhashes. */
type Clock = { height: number };
function setup(o: { maxPositions?: number; balanceSol?: number; dir?: string; chain?: Set<string>; mintX?: string; wallet?: Wallet; clock?: Clock; sigStatus?: Map<string, "confirmed" | "failed" | "unknown" | "processed">; tokenMoves?: Map<string, bigint> } = {}) {
  const clock = o.clock ?? { height: 1000 };
  const LAST_VALID = () => clock.height + 150;
  const wallet = o.wallet ?? { tokens: 0n, balanceReadFailures: 0 }; // shared across "restarts" like the chain
  const dir = o.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "mmlive-"));
  const chain = o.chain ?? new Set<string>(); // position accounts that exist "on chain"
  const sigStatus = o.sigStatus ?? new Map<string, "confirmed" | "failed" | "unknown" | "processed">(); // chain state: shared across restarts
  const tokenMoves = o.tokenMoves ?? new Map<string, bigint>(); // sig → our token delta (for getTransaction)
  const OWNER = "11111111111111111111111111111111";
  let sendMode: SendMode = "ok";
  let removeMode: "ok" | "hang" | "land_then_throw" | "first_never_lands" | "lost_pending" = "ok";
  let rebalanceMode: "ok" | "lost" = "ok";
  let removeSends = 0;
  const calls = { poolInfo: 0, open: 0, send: 0, remove: 0, broadcast: 0, sell: 0, poolSwap: 0, sold: [] as bigint[], rebalance: 0 };
  let poolRoute = false;
  let jupiterMode: "ok" | "land_then_throw" = "ok";
  const gates = { poolInfo: [] as ReturnType<typeof gate>[], send: [] as ReturnType<typeof gate>[], sim: [] as ReturnType<typeof gate>[] };
  let hold = { poolInfo: false, send: false, sim: false };
  const builder = {
    connection: {
      getBalance: async () => Math.round((o.balanceSol ?? 10) * 1e9),
      getBlockHeight: async () => clock.height,
      getAccountInfo: async (pk: PublicKey) => (chain.has(pk.toBase58()) ? { data: Buffer.alloc(0) } : null),
      // only the fields LiveMm reads: our token balance before/after for the mint
      getTransaction: async (sig: string) => {
        if (sigStatus.get(sig) !== "confirmed" && sigStatus.get(sig) !== "failed") return null;
        const d = tokenMoves.get(sig) ?? 0n;
        const bal = (n: bigint) => [{ mint: o.mintX ?? "", owner: OWNER, uiTokenAmount: { amount: n.toString() } }];
        return { meta: { err: sigStatus.get(sig) === "failed" ? {} : null, preTokenBalances: bal(1_000_000n), postTokenBalances: bal(1_000_000n + d) } };
      },
    },
    async poolInfo() {
      calls.poolInfo++;
      if (hold.poolInfo) { const g = gate(); gates.poolInfo.push(g); await g.p; }
      return { solIsY: true, binStep: 100, activeBinId: 0, mintX: o.mintX ?? "So11111111111111111111111111111111111111112" };
    },
    async open() { calls.open++; return { txs: [{}], extraSigners: new Map(), position: posAddr(calls.open) }; },
    async simulateWithdraw() { return { x: 0n, y: 100_000_000n }; },
    async rebalanceOne() { calls.rebalance++; return { txs: [{ rebalance: true }], extraSigners: new Map() }; },
    async remove(r: { position: string }) {
      calls.remove++;
      if (removeMode === "hang") await new Promise(() => {}); // process "crashes" while closing
      return { txs: [{ close: r.position }], extraSigners: new Map() };
    },
    async tokenBalance() {
      if (wallet.balanceReadFailures > 0) { wallet.balanceReadFailures--; throw new Error("429 Too Many Requests"); }
      return wallet.tokens;
    },
    async swapTokenToSol(r: { amount: bigint }) {
      calls.poolSwap++;
      if (!poolRoute) throw new Error("no pool route in fake");
      return { built: { txs: [{ poolSell: r.amount }], extraSigners: new Map() }, outLamports: r.amount };
    },
  };
  const sender = {
    async send(tx: { close?: string; poolSell?: bigint; rebalance?: boolean }, _x: unknown, opts: { onSignature?: (s: string, lv: number) => Promise<void> } = {}) {
      calls.send++;
      const sig = `sig${calls.send}`;
      if (hold.sim) { const g = gate(); gates.sim.push(g); await g.p; } // sender is simulating
      await opts.onSignature?.(sig, LAST_VALID()); // real TxSender: after simulate + sign, before the first broadcast
      calls.broadcast++;
      if (tx.rebalance) {
        if (rebalanceMode === "lost") throw new Error("fetch failed (reply lost)"); // outcome unknown
        sigStatus.set(sig, "confirmed");
        return { signature: sig };
      }
      if (tx.close && removeMode === "lost_pending") throw new Error("fetch failed (reply lost)"); // broadcast, not landed yet
      if (tx.close && removeMode === "first_never_lands" && removeSends++ === 0) {
        throw new Error(`blockhash expired before ${sig} confirmed`); // broadcast, never landed
      }
      if (tx.close) {
        chain.delete(tx.close); // the close landed
        if (o.mintX) { wallet.tokens += 1000n; tokenMoves.set(sig, 1000n); } // the token side comes out of the position
        sigStatus.set(sig, "confirmed");
        if (removeMode === "land_then_throw") throw new Error("fetch failed (reply lost)");
        return { signature: sig };
      }
      if (tx.poolSell !== undefined) {
        wallet.tokens -= tx.poolSell;
        calls.sold.push(tx.poolSell);
        sigStatus.set(sig, "confirmed");
        return { signature: sig };
      }
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
    // TxSender.resolve semantics on the fake chain (uses status(), so tests may override status)
    async resolve(sig: string, lastValid: number | undefined) {
      const a = await (this as { status(s: string): Promise<string> }).status(sig);
      if (a === "confirmed" || a === "failed") return a;
      if (a === "processed" || lastValid === undefined || clock.height <= lastValid) return "pending";
      const b = await (this as { status(s: string): Promise<string> }).status(sig);
      if (b === "confirmed" || b === "failed") return b;
      return b === "unknown" ? "expired" : "pending";
    },
    // Jupiter swap: sells the quoted amount (exact in)
    async sendVersioned(tx: { amount: bigint }, _lv: number, opts: { onSignature?: (s: string, lv: number) => Promise<void> } = {}) {
      calls.sell++;
      const sig = `jup${calls.sell}`;
      await opts.onSignature?.(sig, LAST_VALID());
      wallet.tokens -= tx.amount;
      calls.sold.push(tx.amount);
      sigStatus.set(sig, "confirmed");
      if (jupiterMode === "land_then_throw") throw new Error("fetch failed (reply lost)");
      return { signature: sig };
    },
  };
  const records: Record<string, unknown>[] = [];
  const log = { info() {}, warn() {}, error() {}, debug() {} };
  const mm = new LiveMm(builder as never, sender as never, new PublicKey("11111111111111111111111111111111"), {
    lotLamports: 100_000_000n, maxPositions: o.maxPositions ?? 3, reserveLamports: 150_000_000n, slippageBins: 0,
    priorityMicroLamports: 0, settleEveryMs: 0, stateFile: path.join(dir, "state.json"), killFile: path.join(dir, "STOP"), closeAllFile: path.join(dir, "CLOSE_ALL"),
  }, log as never, (kind, obj) => records.push({ _file: kind, ...obj }));
  // no network: Jupiter replaced by a fake
  (mm as unknown as { jupiter: unknown }).jupiter = {
    async quoteToSol(_m: string, amount: bigint) { return { outAmount: String(amount) }; },
    async buildSwap(q: { outAmount: string }) { return { tx: { amount: BigInt(q.outAmount) }, lastValidBlockHeight: 1 }; },
  };
  return { mm, dir, chain, wallet, clock, sigStatus, tokenMoves, calls, rebalanceMode: (m: typeof rebalanceMode) => (rebalanceMode = m), poolRoute: (v: boolean) => (poolRoute = v), jupiterMode: (m: typeof jupiterMode) => (jupiterMode = m), gates, records, holdAll: (h: Partial<typeof hold>) => (hold = { ...hold, ...h }), sendMode: (m: SendMode) => (sendMode = m), removeMode: (m: typeof removeMode) => (removeMode = m) };
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
    expect(state.opening[0]).toMatchObject({ leaderPosition: "L1", position: posAddr(1), sigs: [{ sig: "sig1", lastValid: 1150 }], closeRequested: true });
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

  it("crash between restoring a position and closing it: the close intent survives the next restart", async () => {
    const s = setup();
    s.sendMode("land_then_hang");
    void s.mm.onLeaderOpen({ leaderPosition: "L1", pool: "P", t: 0 });
    for (let i = 0; i < 10 && s.calls.send === 0; i++) await tick();
    await tick();
    await s.mm.onLeaderClose("L1");
    // restart #1: restores the position, starts the close, "crashes" inside it
    const r1 = setup({ dir: s.dir, chain: s.chain });
    r1.removeMode("hang");
    void r1.mm.checkIdle(Math.floor(Date.now() / 1000));
    for (let i = 0; i < 10 && r1.calls.remove === 0; i++) await tick();
    expect(r1.calls.remove).toBe(1);
    const state = JSON.parse(fs.readFileSync(path.join(s.dir, "state.json"), "utf8"));
    expect(state.opening).toHaveLength(0);
    expect(state.positions[0]).toMatchObject({ leaderPosition: "L1", closeRequested: true, closeReason: "leader_closed" });
    // restart #2: the intent is still there and is carried out
    const r2 = setup({ dir: s.dir, chain: s.chain });
    await r2.mm.checkIdle(Math.floor(Date.now() / 1000));
    expect(r2.calls.broadcast).toBe(1);
    expect(kinds(r2.records)).toEqual(["close:leader_closed"]);
    expect(r2.mm.openCount).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(s.dir, "state.json"), "utf8")).positions).toHaveLength(0);
  });

  it("close landed but its reply was lost: verified on chain, not re-sent forever", async () => {
    const s = setup();
    await s.mm.onLeaderOpen({ leaderPosition: "L1", pool: "P", t: 0 });
    s.removeMode("land_then_throw");
    await s.mm.onLeaderClose("L1");
    expect(kinds(s.records)).toEqual(["open", "close_failed:leader_closed"]);
    expect(s.mm.openCount).toBe(1); // intent kept until verified
    await s.mm.checkIdle(Math.floor(Date.now() / 1000));
    expect(kinds(s.records).at(-1)).toBe("close_verified:leader_closed");
    expect(s.mm.openCount).toBe(0);
    expect(s.calls.remove).toBe(1); // no second close tx
  });

  for (const file of ["STOP", "CLOSE_ALL"]) {
    it(`${file} created while the sender simulates: signed but never broadcast`, async () => {
      const s = setup();
      s.holdAll({ sim: true });
      const a = s.mm.onLeaderOpen({ leaderPosition: "L1", pool: "P", t: 0 });
      for (let i = 0; i < 10 && !s.gates.sim.length; i++) await tick();
      expect(s.calls.send).toBe(1); // inside the sender
      fs.writeFileSync(path.join(s.dir, file), "");
      s.gates.sim.forEach((g) => g.open());
      await a;
      expect(s.calls.broadcast).toBe(0);
      expect(s.mm.openCount).toBe(0);
      expect(kinds(s.records)).toEqual(["open_skipped:kill_file_before_broadcast"]);
      expect(JSON.parse(fs.readFileSync(path.join(s.dir, "state.json"), "utf8")).opening).toHaveLength(0);
    });
  }

  it("leader close while the sender simulates: signed but never broadcast", async () => {
    const s = setup();
    s.holdAll({ sim: true });
    const a = s.mm.onLeaderOpen({ leaderPosition: "L1", pool: "P", t: 0 });
    for (let i = 0; i < 10 && !s.gates.sim.length; i++) await tick();
    await s.mm.onLeaderClose("L1");
    s.gates.sim.forEach((g) => g.open());
    await a;
    expect(s.calls.broadcast).toBe(0);
    expect(s.mm.openCount).toBe(0);
    expect(kinds(s.records)).toEqual(["close_deferred:leader_closed", "open_skipped:leader_closed_before_broadcast"]);
  });

  // The service's own tick (serviceTick, as main.ts runs it), not checkIdle() directly.
  const emptyBook = { pools: () => [] as string[], onTick: () => [], checkExits: () => [] };
  const tickDeps = (mm: LiveMm, readPools = async () => new Map()) => ({ book: emptyBook, live: mm, watcher: null, readPools, write: () => {} });

  it("restart whose only state is an unresolved open: the service tick resolves it (no pools to read)", async () => {
    const s = setup();
    s.sendMode("land_then_hang");
    void s.mm.onLeaderOpen({ leaderPosition: "L1", pool: "P", t: 0 });
    for (let i = 0; i < 10 && s.calls.send === 0; i++) await tick();
    await tick();
    const r = setup({ dir: s.dir, chain: s.chain });
    let reads = 0;
    await serviceTick(tickDeps(r.mm, async () => { reads++; return new Map(); }));
    expect(reads).toBe(0); // nothing to read: book and live have no pools yet
    expect(kinds(r.records)).toEqual(["open_recovered"]);
    expect(r.mm.openCount).toBe(1);
  });

  it("pool read failing does not block live housekeeping", async () => {
    const s = setup();
    await s.mm.onLeaderOpen({ leaderPosition: "L1", pool: "P", t: 0 });
    fs.writeFileSync(path.join(s.dir, "CLOSE_ALL"), "");
    await expect(serviceTick(tickDeps(s.mm, async () => { throw new Error("rpc down"); }))).rejects.toThrow("rpc down");
    expect(kinds(s.records)).toEqual(["open", "close:close_all_file"]);
    expect(s.mm.openCount).toBe(0);
  });

  it("close confirmed, balance read fails: the owed sale survives a restart; close sent once, sale done after", async () => {
    const s = setup({ mintX: TOKEN });
    await s.mm.onLeaderOpen({ leaderPosition: "L1", pool: "P", t: 0 });
    s.wallet.balanceReadFailures = 1; // transient RPC error right after the close
    await s.mm.onLeaderClose("L1");
    expect(kinds(s.records)).toEqual(["open", "close:leader_closed", "sell_failed"]);
    expect(s.calls.remove).toBe(1);
    const state = JSON.parse(fs.readFileSync(path.join(s.dir, "state.json"), "utf8"));
    expect(state.positions).toHaveLength(0);
    expect(state.sales).toMatchObject([{ mintX: TOKEN, position: posAddr(1), tries: 1 }]);
    // restart
    const r = setup({ dir: s.dir, chain: s.chain, mintX: TOKEN, wallet: s.wallet });
    expect(r.mm.pendingSales).toBe(1);
    await serviceTick(tickDeps(r.mm)); // sells
    await serviceTick(tickDeps(r.mm)); // balance 0 → done
    expect(kinds(r.records)).toEqual(["sell", "sell_done"]);
    expect(r.calls.sell).toBe(1);
    expect(r.calls.remove + r.calls.broadcast).toBe(0); // the close is not sent again
    expect(r.mm.pendingSales).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(s.dir, "state.json"), "utf8")).sales).toHaveLength(0);
  });

  it("sells only what THIS close released, not tokens of the same mint already in the wallet", async () => {
    const wallet = { tokens: 500n, balanceReadFailures: 0 }; // 500 of the mint held before
    const s = setup({ mintX: TOKEN, wallet });
    await s.mm.onLeaderOpen({ leaderPosition: "L1", pool: "P", t: 0 });
    await s.mm.onLeaderClose("L1"); // close releases 1000
    await serviceTick(tickDeps(s.mm));
    expect(s.calls.sold).toEqual([1000n]);
    expect(wallet.tokens).toBe(500n);
    expect(kinds(s.records)).toEqual(["open", "close:leader_closed", "sell", "sell_done"]);
  });

  it("Jupiter swap landed with its reply lost: no pool fallback; resolved from chain, nothing else sold", async () => {
    const wallet = { tokens: 0n, balanceReadFailures: 0 };
    const s = setup({ mintX: TOKEN, wallet });
    s.poolRoute(true);
    s.jupiterMode("land_then_throw");
    await s.mm.onLeaderOpen({ leaderPosition: "L1", pool: "P", t: 0 });
    await s.mm.onLeaderClose("L1");
    expect(s.calls.poolSwap).toBe(0); // no second sale on the other route
    expect(kinds(s.records).at(-1)).toBe("sell_failed");
    expect(JSON.parse(fs.readFileSync(path.join(s.dir, "state.json"), "utf8")).sales[0].inFlight).toMatchObject({ sig: "jup1", route: "jupiter", amount: "1000" });
    wallet.tokens += 300n; // more of the same mint arrives meanwhile
    // restart, then the service tick resolves the in-flight swap from chain
    const r = setup({ dir: s.dir, chain: s.chain, mintX: TOKEN, wallet });
    (r.mm as unknown as { sender: { status: (sig: string) => Promise<string> } }).sender.status = async (sig) => (sig === "jup1" ? "confirmed" : "unknown");
    r.poolRoute(true);
    await serviceTick(tickDeps(r.mm));
    expect(kinds(r.records)).toEqual(["sell_confirmed", "sell_done"]);
    expect(s.calls.sold).toEqual([1000n]);
    expect(r.calls.sold).toEqual([]);
    expect(r.calls.poolSwap).toBe(0);
    expect(wallet.tokens).toBe(300n); // untouched
  });

  it("Jupiter swap known NOT to have landed: only then the pool route sells the owed amount", async () => {
    const wallet = { tokens: 0n, balanceReadFailures: 0 };
    const s = setup({ mintX: TOKEN, wallet });
    s.poolRoute(true);
    const snd = (s.mm as unknown as { sender: Record<string, unknown> }).sender;
    snd.sendVersioned = async (_tx: unknown, _lv: number, opts: { onSignature?: (x: string, lv: number) => Promise<void> } = {}) => { await opts.onSignature?.("jupX", 1150); throw new Error("blockhash expired"); };
    const realStatus = snd.status as (sig: string) => Promise<string>;
    snd.status = async (sig: string) => (sig === "jupX" ? "failed" : realStatus(sig));
    await s.mm.onLeaderOpen({ leaderPosition: "L1", pool: "P", t: 0 });
    await s.mm.onLeaderClose("L1");
    expect(s.calls.poolSwap).toBe(0);
    await serviceTick(tickDeps(s.mm), Math.floor(Date.now() / 1000) + 60); // resolves jupX as failed → pool
    await serviceTick(tickDeps(s.mm), Math.floor(Date.now() / 1000) + 120);
    expect(kinds(s.records).slice(2)).toEqual(["sell_failed", "sell_not_landed", "sell", "sell_done"]);
    expect(s.calls.sold).toEqual([1000n]);
    expect(wallet.tokens).toBe(0n);
  });

  it("sale outcome still unknown long after sending but within its validity: wait, no other route", async () => {
    const wallet = { tokens: 0n, balanceReadFailures: 0 };
    const s = setup({ mintX: TOKEN, wallet });
    s.poolRoute(true);
    s.jupiterMode("land_then_throw");
    await s.mm.onLeaderOpen({ leaderPosition: "L1", pool: "P", t: 0 });
    await s.mm.onLeaderClose("L1"); // Jupiter sells 1000, reply lost
    s.sigStatus.set("jup1", "unknown"); // the RPC has not found the landed signature yet
    wallet.tokens += 300n; // same mint arrives
    const t0 = Math.floor(Date.now() / 1000);
    vi.useFakeTimers({ toFake: ["Date"] }); // wall clock too: the old rule used Date.now()
    try {
      for (const dt of [60, 200, 600]) {
        vi.setSystemTime((t0 + dt) * 1000);
        await serviceTick(tickDeps(s.mm), t0 + dt); // > 120 s: the old time rule switched routes here
      }
    } finally {
      vi.useRealTimers();
    }
    expect(s.calls.poolSwap).toBe(0);
    expect(s.calls.sold).toEqual([1000n]);
    s.sigStatus.set("jup1", "confirmed"); // RPC catches up
    await serviceTick(tickDeps(s.mm), t0 + 1200);
    expect(kinds(s.records).slice(-2)).toEqual(["sell_confirmed", "sell_done"]);
    expect(wallet.tokens).toBe(300n);
  });

  it("first close never lands, the retry confirms: the expired one is left out and the sale proceeds", async () => {
    const wallet = { tokens: 0n, balanceReadFailures: 0 };
    const s = setup({ mintX: TOKEN, wallet });
    await s.mm.onLeaderOpen({ leaderPosition: "L1", pool: "P", t: 0 });
    s.removeMode("first_never_lands");
    await s.mm.onLeaderClose("L1"); // close #1: broadcast, never lands
    expect(kinds(s.records).at(-1)).toBe("close_failed:leader_closed");
    s.clock.height += 200; // close #1's blockhash is now past its last valid height
    await serviceTick(tickDeps(s.mm)); // close #2 (intent restored) confirms → sale
    await serviceTick(tickDeps(s.mm));
    const state = JSON.parse(fs.readFileSync(path.join(s.dir, "state.json"), "utf8"));
    expect(state.positions).toHaveLength(0);
    expect(state.sales).toHaveLength(0);
    expect(kinds(s.records).slice(-3)).toEqual(["close:leader_closed", "sell", "sell_done"]);
    expect(s.calls.sold).toEqual([1000n]);
  });

  it("a close whose outcome is still pending holds the sale (no guess)", async () => {
    // restart on a state whose close signature this RPC cannot see yet (within its validity)
    const s2 = setup({ mintX: TOKEN, wallet: { tokens: 1000n, balanceReadFailures: 0 } });
    fs.writeFileSync(path.join(s2.dir, "state.json"), JSON.stringify({ positions: [], opening: [], sales: [{ leaderPosition: "L9", position: "Pos9", pool: "P", mintX: TOKEN, since: 0, tries: 0, nextAt: 0, closeSigs: [{ sig: "closeZ", lastValid: 1150 }], sold: "0" }] }));
    const r = setup({ dir: s2.dir, mintX: TOKEN, wallet: { tokens: 1000n, balanceReadFailures: 0 } });
    await serviceTick(tickDeps(r.mm));
    expect(r.calls.sold).toEqual([]);
    expect(r.mm.pendingSales).toBe(1);
    expect(kinds(r.records)).toEqual(["sell_failed"]); // "close outcome pending": retried, nothing sold
  });

  it("close reply lost, its signature still valid: the next ticks build NO second close; it lands → verified, sale", async () => {
    const wallet = { tokens: 0n, balanceReadFailures: 0 };
    const s = setup({ mintX: TOKEN, wallet });
    await s.mm.onLeaderOpen({ leaderPosition: "L1", pool: "P", t: 0 });
    s.removeMode("lost_pending");
    await s.mm.onLeaderClose("L1");
    expect(s.calls.remove).toBe(1);
    for (let i = 0; i < 3; i++) await serviceTick(tickDeps(s.mm));
    expect(s.calls.remove).toBe(1); // pending: nothing new built
    // the first close lands
    s.chain.delete(posAddr(1));
    s.sigStatus.set("sig2", "confirmed");
    s.tokenMoves.set("sig2", 1000n);
    wallet.tokens += 1000n;
    await serviceTick(tickDeps(s.mm));
    await serviceTick(tickDeps(s.mm));
    expect(s.calls.remove).toBe(1);
    expect(kinds(s.records).slice(-3)).toEqual(["close_verified:leader_closed", "sell", "sell_done"]);
    expect(s.calls.sold).toEqual([1000n]);
  });

  it("close reply lost and its blockhash then expires: only then a new close is built", async () => {
    const s = setup();
    await s.mm.onLeaderOpen({ leaderPosition: "L1", pool: "P", t: 0 });
    s.removeMode("lost_pending");
    await s.mm.onLeaderClose("L1");
    await serviceTick(tickDeps(s.mm));
    expect(s.calls.remove).toBe(1);
    s.clock.height += 200; // past the first close's last valid height, still not found → expired
    s.removeMode("ok");
    await serviceTick(tickDeps(s.mm));
    expect(s.calls.remove).toBe(2);
    expect(s.mm.openCount).toBe(0);
  });

  it("a close the RPC sees only as processed stays pending past its last valid height", async () => {
    const s = setup();
    await s.mm.onLeaderOpen({ leaderPosition: "L1", pool: "P", t: 0 });
    s.removeMode("lost_pending");
    await s.mm.onLeaderClose("L1");
    s.sigStatus.set("sig2", "processed");
    s.clock.height += 200;
    s.removeMode("ok");
    await serviceTick(tickDeps(s.mm));
    expect(s.calls.remove).toBe(1); // not expired: no second close
    expect(s.mm.openCount).toBe(1);
  });

  it("rebalance reply lost: no second rebalance and no close until it resolves; confirmed → planned range", async () => {
    const s = setup();
    await s.mm.onLeaderOpen({ leaderPosition: "L1", pool: "P", t: 0 });
    const ours = () => [...(s.mm as unknown as { ours: Map<string, { range: { lower: number; upper: number }; rebalanceInFlight?: unknown }> }).ours.values()][0]!;
    const before = { ...ours().range };
    s.rebalanceMode("lost");
    s.mm.onTick("P", before.upper + 3); // 3 bins away → rebalance
    for (let i = 0; i < 10 && s.calls.rebalance === 0; i++) await tick();
    await tick(); await tick();
    expect(kinds(s.records).at(-1)).toBe("rebalance_uncertain");
    s.mm.onTick("P", before.upper + 5);
    for (let i = 0; i < 5; i++) await tick();
    expect(s.calls.rebalance).toBe(1); // still pending: not another one
    await s.mm.onLeaderClose("L1");
    expect(s.calls.remove).toBe(0); // close waits for the pending rebalance
    // the rebalance turns out confirmed
    const sig = (ours().rebalanceInFlight as { sigs: { sig: string }[] }).sigs[0]!.sig;
    s.sigStatus.set(sig, "confirmed");
    await serviceTick(tickDeps(s.mm));
    expect(kinds(s.records)).toContain("rebalance_confirmed");
    expect(s.calls.remove).toBe(1); // then the persisted close intent runs
    expect(s.mm.openCount).toBe(0);
  });

  it("rebalance reply lost and expired: range unchanged, the next tick may rebalance again", async () => {
    const s = setup();
    await s.mm.onLeaderOpen({ leaderPosition: "L1", pool: "P", t: 0 });
    const ours = () => [...(s.mm as unknown as { ours: Map<string, { range: { lower: number; upper: number } }> }).ours.values()][0]!;
    const before = { ...ours().range };
    s.rebalanceMode("lost");
    s.mm.onTick("P", before.upper + 3);
    for (let i = 0; i < 10 && s.calls.rebalance === 0; i++) await tick();
    await tick(); await tick();
    s.clock.height += 200;
    await serviceTick(tickDeps(s.mm)); // settles as not landed
    expect(kinds(s.records).at(-1)).toBe("rebalance_not_landed");
    expect(ours().range).toEqual(before);
    s.rebalanceMode("ok");
    s.mm.onTick("P", before.upper + 3);
    for (let i = 0; i < 10 && s.calls.rebalance < 2; i++) await tick();
    await tick(); await tick();
    expect(s.calls.rebalance).toBe(2);
    expect(kinds(s.records).at(-1)).toBe("rebalance");
  });
});
