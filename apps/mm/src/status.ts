import fs from "node:fs";

/**
 * live-status.json: what the running service has in flight, for a SAFE stop after CLOSE_ALL.
 * Written atomically (tmp + rename). `closeAllRequestedAt` is the mtime of the CLOSE_ALL file the
 * service saw, so a stop can tell "idle after THIS request" from an old record (a previous run, a
 * previous request, or a file written before the request).
 */
export interface LiveStatus {
  runId: string;
  startedAt: number; // ms
  t: number; // ms, when this record was written
  closeAll: boolean;
  closeAllRequestedAt: number | null; // ms, mtime of the CLOSE_ALL file seen by this run
  idle: boolean;
  [k: string]: unknown;
}

export function writeStatus(file: string, st: LiveStatus): void {
  fs.writeFileSync(file + ".tmp", JSON.stringify(st, null, 1));
  fs.renameSync(file + ".tmp", file);
}

/** runId of the service holding the data directory now: from mm.lock with a fresh heartbeat. */
export function runningRunId(lockFile: string, now = Date.now(), staleMs = 30_000): string | null {
  try {
    const l = JSON.parse(fs.readFileSync(lockFile, "utf8")) as { heartbeat: number; runId?: string };
    return now - l.heartbeat < staleMs && l.runId ? l.runId : null;
  } catch {
    return null;
  }
}

export function closeAllMtime(file: string): number | null {
  try {
    return Math.floor(fs.statSync(file).mtimeMs);
  } catch {
    return null;
  }
}

/**
 * Is it safe to stop now? Only on a record written by the running service AFTER it saw the current
 * CLOSE_ALL request, fresh, with closeAll and idle both true.
 */
export function stopSafe(st: LiveStatus | null, requestMtime: number | null, runningRunId: string | null, now = Date.now(), maxAgeMs = 30_000): { ok: boolean; why: string } {
  if (requestMtime === null) return { ok: false, why: "no CLOSE_ALL request" };
  if (!st) return { ok: false, why: "no status record" };
  // the record must come from the service that is running NOW (same CLOSE_ALL file can outlive a restart)
  if (!runningRunId) return { ok: false, why: "no running service (lock heartbeat missing or stale)" };
  if (st.runId !== runningRunId) return { ok: false, why: "status record is from another run" };
  if (now - st.t > maxAgeMs) return { ok: false, why: `status record is ${Math.round((now - st.t) / 1000)} s old (service not writing?)` };
  if (st.closeAllRequestedAt !== requestMtime) return { ok: false, why: "the service has not seen this CLOSE_ALL request yet" };
  if (st.t < requestMtime) return { ok: false, why: "record written before the request" };
  if (!st.closeAll) return { ok: false, why: "closeAll not active" };
  if (!st.idle) return { ok: false, why: "positions, opens or sales still in flight" };
  return { ok: true, why: "idle after this CLOSE_ALL" };
}

/**
 * Which pools' freshness gates a NEW open: only the pools of positions WE hold. Not the shadow
 * book's (they include the leader's brand-new pool, never read yet: every open was refused as
 * "stale"), and not the pool being opened (the open reads it itself, fresh, before building).
 */
export function ourPoolAges(livePools: string[], ageMs: (pool: string) => number): number[] {
  return [...new Set(livePools)].map(ageMs);
}

/**
 * Running is not ready: the service is READY for new opens only after its first successful leader
 * read, and only while the leader feed, the pool reads and every tracked pool are fresh. Recovery
 * and closes do not depend on this.
 */
export class Readiness {
  leaderEverOk = false;
  lastLeaderOk: number;
  lastTickOk: number;

  constructor(private readonly staleMs: number, now = Date.now()) {
    this.lastLeaderOk = now; // start-up grace for the HEALTH check only; opens wait for leaderEverOk
    this.lastTickOk = now;
  }

  /** Returns true the first time (log it). */
  leaderOk(now = Date.now()): boolean {
    this.lastLeaderOk = now;
    const first = !this.leaderEverOk;
    this.leaderEverOk = true;
    return first;
  }

  tickOk(now = Date.now()): void {
    this.lastTickOk = now;
  }

  /** Why new opens must wait (null = ready). poolAgesMs: age of the newest observation per tracked pool. */
  staleness(poolAgesMs: number[], now = Date.now()): string | null {
    if (!this.leaderEverOk) return "starting: no successful leader read yet";
    if (now - this.lastLeaderOk > this.staleMs) return `leader feed ${Math.round((now - this.lastLeaderOk) / 1000)} s behind`;
    if (now - this.lastTickOk > this.staleMs) return `pool reads ${Math.round((now - this.lastTickOk) / 1000)} s behind`;
    const old = poolAgesMs.filter((a) => a > this.staleMs).length;
    return old ? `${old} pool(s) without a fresh observation` : null;
  }
}
