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
  let readError: unknown;
  if (pools.length) {
    try {
      const states = await d.readPools(pools);
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
  await d.live?.checkIdle(now);
  if (readError) throw readError;
}
