import type { ShadowBook } from "@binflip/core";
import type { SlotGate } from "./slotGate.js";

/** What one service tick needs; main.ts wires the real ones, tests pass fakes. */
export interface TickDeps {
  book: Pick<ShadowBook, "pools" | "onTick" | "checkExits">;
  live: { pools(): string[]; onTick(pool: string, active: number): void; checkIdle(now: number): Promise<void> } | null;
  watcher: { setAddresses(pools: string[]): void } | null;
  readPools(pools: string[]): Promise<Map<string, { activeId: number; slot?: number }>>;
  write(kind: string, obj: Record<string, unknown>): void;
  /** Shared with the WebSocket path: stale observations (older slot than already seen) are dropped. */
  gate?: SlotGate;
  /** Bound on the pool read (default 20 s): a read that never answers must not stall the loop. */
  readTimeoutMs?: number;
}

/**
 * One pass of the service's tick loop. Live housekeeping (resolving opens with an unknown
 * outcome, owed token sales, idle / CLOSE_ALL exits) runs on EVERY tick, also when there is
 * no pool to read (e.g. after a restart whose only state is an unresolved open) and when the
 * pool read fails. A pool-read error is rethrown after the housekeeping.
 */
export async function serviceTick(d: TickDeps, now = Math.floor(Date.now() / 1000)): Promise<void> {
  const pools = [...new Set([...d.book.pools(), ...(d.live?.pools() ?? [])])];
  d.watcher?.setAddresses(pools);
  // Live housekeeping starts FIRST and runs alongside the pool read: CLOSE_ALL intents are persisted
  // at its very start, so neither a slow nor a hung price read can keep them from disk.
  // The rejection handler is attached NOW (not after the read): a housekeeping error while the read
  // is pending must never become an unhandledRejection; it is rethrown to the loop below.
  const housekeeping: Promise<unknown> = (d.live ? d.live.checkIdle(now) : Promise.resolve()).then(
    () => null,
    (err: unknown) => ({ housekeepingError: err }),
  );
  let readError: unknown;
  if (pools.length) {
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const states = await Promise.race([
        d.readPools(pools),
        new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`pool read took longer than ${d.readTimeoutMs ?? 20_000} ms`)), d.readTimeoutMs ?? 20_000); }),
      ]).finally(() => clearTimeout(timer));
      if (states.size === 0) throw new Error(`pool read returned no accounts for ${pools.length} pools`); // empty ≠ fresh
      for (const [pool, s] of states) {
        if (d.gate && !d.gate.accept(pool, s.slot)) continue; // older than what we already acted on
        for (const x of d.book.onTick(pool, s.activeId, now, s.slot)) d.write("ours", { t: now, slot: s.slot, pool, active: s.activeId, via: "poll", ...x });
        d.live?.onTick(pool, s.activeId);
      }
    } catch (err) {
      readError = err;
    }
  }
  for (const p of d.book.checkExits(now)) d.write("ours", { t: now, pool: p.pool, position: p.position, kind: "idle_exit", lastMoveAt: p.lastMoveAt });
  const hk = (await housekeeping) as { housekeepingError: unknown } | null;
  if (hk) throw hk.housekeepingError; // the loop logs it ("loop error")
  if (readError) throw readError;
}
