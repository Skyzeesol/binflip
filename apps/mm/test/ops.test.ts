// Operations: settings validation, single writer, record pruning, stale-data gate, live status.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { ConfigError, parseMmConfig } from "../src/config.js";
import { WriterLock, pruneJsonl } from "../src/writerLock.js";
import { LiveMm } from "../src/live.js";
import { FakeChain, OWNER } from "./fakeChain.js";

describe("settings are validated before anything starts", () => {
  it("MM_MAX_POSITIONS=oops, a negative reserve and a 1 ms timer are refused (all reported)", () => {
    let err: Error | undefined;
    try { parseMmConfig({ MM_MAX_POSITIONS: "oops", MM_RESERVE_SOL: "-1", MM_TICK_MS: "1" }); } catch (e) { err = e as Error; }
    expect(err).toBeInstanceOf(ConfigError);
    expect(err!.message).toMatch(/MM_MAX_POSITIONS/);
    expect(err!.message).toMatch(/MM_RESERVE_SOL/);
    expect(err!.message).toMatch(/MM_TICK_MS/);
  });
  it("mode and commitment must be known values; the leader must be a public key", () => {
    expect(() => parseMmConfig({ MM_LIVE: "yes" })).toThrow(/MM_LIVE/);
    expect(() => parseMmConfig({ MM_COMMITMENT: "finalised" })).toThrow(/MM_COMMITMENT/);
    expect(() => parseMmConfig({ MM_LEADER: "not-a-key" })).toThrow(/MM_LEADER/);
  });
  it("defaults are valid and typed", () => {
    const c = parseMmConfig({});
    expect(c).toMatchObject({ maxPositions: 3, lotLamports: 100_000_000n, reserveLamports: 150_000_000n, live: false, commitment: "processed" });
  });
});

describe("one writer per data directory", () => {
  it("a second process refuses while the first is alive; a stale lock is taken over", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lock-"));
    const a = new WriterLock(dir, 30_000);
    a.acquire();
    expect(() => new WriterLock(dir, 30_000).acquire()).toThrow(/another mm process/);
    a.release();
    fs.writeFileSync(path.join(dir, "mm.lock"), JSON.stringify({ pid: 1, host: "h", heartbeat: Date.now() - 60_000 }));
    const b = new WriterLock(dir, 30_000);
    expect(() => b.acquire()).not.toThrow();
    b.release();
  });
  it("record files older than the retention are pruned, state files are kept", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prune-"));
    for (const f of ["compare.2026-01-01.jsonl", "compare.2026-11-27.jsonl", "live-state.json", "leader-feed.json"]) fs.writeFileSync(path.join(dir, f), "x");
    expect(pruneJsonl(dir, 14, Date.parse("2026-11-28T12:00:00Z"))).toEqual(["compare.2026-01-01.jsonl"]);
    expect(fs.readdirSync(dir).sort()).toEqual(["compare.2026-11-27.jsonl", "leader-feed.json", "live-state.json"]);
  });
});

describe("stale data stops new opens, not recovery", () => {
  it("no new open while stale; the status says what is in flight and whether it is idle", async () => {
    const c = new FakeChain();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stale-"));
    let stale: string | null = "leader feed 45 s behind";
    const recs: Array<Record<string, unknown>> = [];
    const mm = new LiveMm(c.builder() as never, c.sender() as never, new PublicKey(OWNER), {
      lotLamports: 100_000_000n, maxPositions: 3, reserveLamports: 150_000_000n, slippageBins: 0, priorityMicroLamports: 0,
      stateFile: path.join(dir, "s.json"), killFile: path.join(dir, "STOP"), closeAllFile: path.join(dir, "CLOSE_ALL"), stale: () => stale,
    }, { info() {}, warn() {}, error() {}, debug() {} } as never, (_k, o) => recs.push(o));
    (mm as unknown as { jupiter: unknown }).jupiter = c.jupiter(); // no network
    await mm.onLeaderOpen({ leaderPosition: "L1", pool: "P", t: Math.floor(Date.now() / 1000) });
    expect(recs.map((r) => r.reason)).toEqual(["stale_data"]);
    expect(mm.status()).toMatchObject({ open: 0, idle: true });
    stale = null;
    await mm.onLeaderOpen({ leaderPosition: "L1", pool: "P", t: Math.floor(Date.now() / 1000) });
    expect(mm.status()).toMatchObject({ open: 1, idle: false });
    stale = "pool reads 40 s behind";
    await mm.onLeaderClose("L1"); // closes go on while stale
    expect(mm.status()).toMatchObject({ open: 0, salesOwed: 1, idle: false }); // sold; the record closes on the next pass
    await mm.checkIdle(Math.floor(Date.now() / 1000));
    expect(mm.status()).toMatchObject({ open: 0, salesOwed: 0, idle: true });
  });
});

describe("live idle exit is off unless configured", () => {
  it("a position idle for hours is NOT closed by default; with MM_IDLE_EXIT_MIN it is", async () => {
    for (const idleSec of [undefined, 55 * 60]) {
      const c = new FakeChain();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "idle-"));
      const recs: Array<Record<string, unknown>> = [];
      const mm = new LiveMm(c.builder() as never, c.sender() as never, new PublicKey(OWNER), {
        lotLamports: 100_000_000n, maxPositions: 3, reserveLamports: 150_000_000n, slippageBins: 0, priorityMicroLamports: 0,
        stateFile: path.join(dir, "s.json"), killFile: path.join(dir, "STOP"), closeAllFile: path.join(dir, "CLOSE_ALL"), idleSec,
      }, { info() {}, warn() {}, error() {}, debug() {} } as never, (_k, o) => recs.push(o));
      (mm as unknown as { jupiter: unknown }).jupiter = c.jupiter();
      await mm.onLeaderOpen({ leaderPosition: "L1", pool: "P", t: Math.floor(Date.now() / 1000) });
      await mm.checkIdle(Math.floor(Date.now() / 1000) + 3 * 3600);
      expect(recs.some((r) => r.kind === "close")).toBe(idleSec !== undefined);
    }
    expect(parseMmConfig({}).idleExitSec).toBe(0);
    expect(parseMmConfig({ MM_IDLE_EXIT_MIN: "55" }).idleExitSec).toBe(3300);
  });
});

