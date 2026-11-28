import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * One writer per data directory (state file, JSONL): a lock file with a heartbeat. A second
 * process (another compose project on the same checkout, a stray tmux) refuses to start while
 * the heartbeat is fresh; a crashed holder's lock goes stale after `staleMs` and is taken over.
 */
export class WriterLock {
  private timer: ReturnType<typeof setInterval> | null = null;
  readonly file: string;

  constructor(dir: string, private readonly staleMs = 30_000, readonly runId?: string) {
    this.file = path.join(dir, "mm.lock");
  }

  acquire(now = Date.now()): void {
    if (fs.existsSync(this.file)) {
      try {
        const cur = JSON.parse(fs.readFileSync(this.file, "utf8")) as { pid: number; host: string; heartbeat: number };
        if (now - cur.heartbeat < this.staleMs) throw new Error(`another mm process (pid ${cur.pid} on ${cur.host}) writes to ${path.dirname(this.file)}; refusing to start`);
      } catch (err) {
        if ((err as Error).message.startsWith("another mm")) throw err; // unreadable lock: take it over
      }
    }
    this.beat(now);
    this.timer = setInterval(() => this.beat(), Math.max(1000, Math.floor(this.staleMs / 3)));
    this.timer.unref?.();
  }

  private beat(now = Date.now()): void {
    fs.writeFileSync(this.file + ".tmp", JSON.stringify({ pid: process.pid, host: os.hostname(), heartbeat: now, runId: this.runId }));
    fs.renameSync(this.file + ".tmp", this.file);
  }

  release(): void {
    if (this.timer) clearInterval(this.timer);
    try { fs.unlinkSync(this.file); } catch { /* already gone */ }
  }
}

/** Delete `<kind>.<YYYY-MM-DD>.jsonl` files older than keepDays (state and lock files are kept). */
export function pruneJsonl(dir: string, keepDays: number, now = Date.now()): string[] {
  const cutoff = new Date(now - keepDays * 86_400_000).toISOString().slice(0, 10);
  const removed: string[] = [];
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const m = /\.(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
    if (m && m[1]! < cutoff) { fs.unlinkSync(path.join(dir, f)); removed.push(f); }
  }
  return removed;
}
