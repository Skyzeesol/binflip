import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
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
function setup(o: { maxPositions?: number; balanceSol?: number; dir?: string; chain?: Set<string>; mintX?: string; wallet?: Wallet } = {}) {
  const wallet = o.wallet ?? { tokens: 0n, balanceReadFailures: 0 }; // shared across "restarts" like the chain
  const dir = o.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "mmlive-"));
  const chain = o.chain ?? new Set<string>(); // position accounts that exist "on chain"
  const sigStatus = new Map<string, "confirmed" | "failed" | "unknown">();
  const tokenMoves = new Map<string, bigint>(); // sig → our token delta (for getTransaction)
  const OWNER = "11111111111111111111111111111111";
  let sendMode: SendMode = "ok";
  let removeMode: "ok" | "hang" | "land_then_throw" = "ok";
  const calls = { poolInfo: 0, open: 0, send: 0, remove: 0, broadcast: 0, sell: 0, poolSwap: 0, sold: [] as bigint[] };
  let poolRoute = false;
  let jupiterMode: "ok" | "land_then_throw" = "ok";
  const gates = { poolInfo: [] as ReturnType<typeof gate>[], send: [] as ReturnType<typeof gate>[], sim: [] as ReturnType<typeof gate>[] };
  let hold = { poolInfo: false, send: false, sim: false };
  const builder = {
    connection: {
      getBalance: async () => Math.round((o.balanceSol ?? 10) * 1e9),
      getAccountInfo: async (pk: PublicKey) => (chain.has(pk.toBase58()) ? { data: Buffer.alloc(0) } : null),
      // only the fields LiveMm reads: our token balance before/after for the mint
      getTransaction: async (sig: string) => {
        if (!sigStatus.has(sig)) return null;
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
    async send(tx: { close?: string; poolSell?: bigint }, _x: unknown, opts: { onSignature?: (s: string) => Promise<void> } = {}) {
      calls.send++;
      const sig = `sig${calls.send}`;
      if (hold.sim) { const g = gate(); gates.sim.push(g); await g.p; } // sender is simulating
      await opts.onSignature?.(sig); // real TxSender: after simulate + sign, before the first broadcast
      calls.broadcast++;
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
    // Jupiter swap: sells the quoted amount (exact in)
    async sendVersioned(tx: { amount: bigint }, _lv: number, opts: { onSignature?: (s: string) => Promise<void> } = {}) {
      calls.sell++;
      const sig = `jup${calls.sell}`;
      await opts.onSignature?.(sig);
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
    priorityMicroLamports: 0, stateFile: path.join(dir, "state.json"), killFile: path.join(dir, "STOP"), closeAllFile: path.join(dir, "CLOSE_ALL"),
  }, log as never, (kind, obj) => records.push({ _file: kind, ...obj }));
  // no network: Jupiter replaced by a fake
  (mm as unknown as { jupiter: unknown }).jupiter = {
    async quoteToSol(_m: string, amount: bigint) { return { outAmount: String(amount) }; },
    async buildSwap(q: { outAmount: string }) { return { tx: { amount: BigInt(q.outAmount) }, lastValidBlockHeight: 1 }; },
  };
  return { mm, dir, chain, wallet, calls, poolRoute: (v: boolean) => (poolRoute = v), jupiterMode: (m: typeof jupiterMode) => (jupiterMode = m), gates, records, holdAll: (h: Partial<typeof hold>) => (hold = { ...hold, ...h }), sendMode: (m: SendMode) => (sendMode = m), removeMode: (m: typeof removeMode) => (removeMode = m) };
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
    snd.sendVersioned = async (_tx: unknown, _lv: number, opts: { onSignature?: (x: string) => Promise<void> } = {}) => { await opts.onSignature?.("jupX"); throw new Error("blockhash expired"); };
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
});
