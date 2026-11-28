// Safe stop after CLOSE_ALL, and readiness before the first leader read.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { LiveMm } from "../src/live.js";
import { Readiness, closeAllMtime, runningRunId, stopSafe, writeStatus, type LiveStatus } from "../src/status.js";
import { WriterLock } from "../src/writerLock.js";
import { FakeChain, OWNER } from "./fakeChain.js";

const st = (o: Partial<LiveStatus>): LiveStatus => ({ runId: "r", startedAt: 0, t: 0, closeAll: false, closeAllRequestedAt: null, idle: true, ...o });

describe("stop only on a fresh record that saw THIS CLOSE_ALL", () => {
  it("a status file left by a previous run (idle: true, closeAll: false, old) does not allow the stop", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stop-"));
    const status = path.join(dir, "live-status.json"), req = path.join(dir, "CLOSE_ALL");
    writeStatus(status, st({ runId: "previous", t: Date.now() - 3_600_000, idle: true, closeAll: false }));
    fs.writeFileSync(req, "");
    const old = JSON.parse(fs.readFileSync(status, "utf8"));
    expect(stopSafe(old, closeAllMtime(req), "current").ok).toBe(false);
  });

  it("idle for an EARLIER request, or written before this one, does not count; only after this request does", () => {
    const now = 2_000_000;
    const reqAt = 1_990_000;
    expect(stopSafe(st({ t: now - 1000, closeAll: true, closeAllRequestedAt: reqAt - 60_000, idle: true }), reqAt, "r", now).ok).toBe(false); // earlier request
    expect(stopSafe(st({ t: reqAt - 10, closeAll: true, closeAllRequestedAt: reqAt, idle: true }), reqAt, "r", now, 60_000).ok).toBe(false); // before the request
    expect(stopSafe(st({ t: now - 1000, closeAll: true, closeAllRequestedAt: reqAt, idle: false }), reqAt, "r", now).ok).toBe(false); // still busy
    expect(stopSafe(st({ t: now - 1000, closeAll: true, closeAllRequestedAt: reqAt, idle: true }), reqAt, "r", now).ok).toBe(true);
    expect(stopSafe(st({ t: now - 1000, closeAll: true, closeAllRequestedAt: reqAt, idle: true }), null, "r", now).ok).toBe(false); // no request
    // the SAME request, but the record comes from a previous run (the CLOSE_ALL file outlived a restart)
    expect(stopSafe(st({ runId: "previous", t: now - 1000, closeAll: true, closeAllRequestedAt: reqAt, idle: true }), reqAt, "current", now)).toMatchObject({ ok: false, why: "status record is from another run" });
    expect(stopSafe(st({ t: now - 1000, closeAll: true, closeAllRequestedAt: reqAt, idle: true }), reqAt, null, now).ok).toBe(false); // no running service
  });

  it("the status file is replaced atomically (no partial JSON)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stop-"));
    const f = path.join(dir, "live-status.json");
    writeStatus(f, st({ t: 1 }));
    writeStatus(f, st({ t: 2 }));
    expect(JSON.parse(fs.readFileSync(f, "utf8")).t).toBe(2);
    expect(fs.existsSync(f + ".tmp")).toBe(false);
  });
});

describe("readiness", () => {
  it("an open request before the first successful leader read is refused; after it, allowed", async () => {
    const r = new Readiness(30_000);
    const c = new FakeChain();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ready-"));
    const recs: Array<Record<string, unknown>> = [];
    const mm = new LiveMm(c.builder() as never, c.sender() as never, new PublicKey(OWNER), {
      lotLamports: 100_000_000n, maxPositions: 1, reserveLamports: 150_000_000n, slippageBins: 0, priorityMicroLamports: 0,
      stateFile: path.join(dir, "s.json"), killFile: path.join(dir, "STOP"), closeAllFile: path.join(dir, "CLOSE_ALL"),
      stale: () => r.staleness([]),
    }, { info() {}, warn() {}, error() {}, debug() {} } as never, (_k, o) => recs.push(o));
    await mm.onLeaderOpen({ leaderPosition: "L1", pool: "P", t: Math.floor(Date.now() / 1000) });
    expect(recs.map((x) => `${x.kind}:${x.reason}:${x.why}`)).toEqual(["open_skipped:stale_data:starting: no successful leader read yet"]);
    expect(c.broadcasts).toHaveLength(0);
    expect(r.leaderOk()).toBe(true); // first read (logged once)
    expect(r.leaderOk()).toBe(false);
    r.tickOk();
    await mm.onLeaderOpen({ leaderPosition: "L1", pool: "P", t: Math.floor(Date.now() / 1000) });
    expect(c.broadcasts.map((b) => b.kind)).toEqual(["open"]);
  });

  it("stale feed, stale reads or a stale pool block new opens with a reason", () => {
    const r = new Readiness(30_000, 0);
    r.leaderOk(0); r.tickOk(0);
    expect(r.staleness([1000], 10_000)).toBeNull();
    expect(r.staleness([], 40_000)).toMatch(/leader feed 40 s behind/);
    r.leaderOk(40_000);
    expect(r.staleness([], 40_000)).toMatch(/pool reads 40 s behind/);
    r.tickOk(40_000);
    expect(r.staleness([45_000], 40_000)).toMatch(/1 pool/);
  });
});

describe("the running run is read from the lock heartbeat", () => {
  it("fresh lock → its runId; stale or missing → none", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-"));
    const lock = new WriterLock(dir, 30_000, "run-A");
    lock.acquire();
    expect(runningRunId(path.join(dir, "mm.lock"))).toBe("run-A");
    expect(runningRunId(path.join(dir, "mm.lock"), Date.now() + 60_000)).toBeNull();
    lock.release();
    expect(runningRunId(path.join(dir, "mm.lock"))).toBeNull();
  });
});

