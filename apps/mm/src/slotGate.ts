/**
 * One slot order for every pool observation, whatever its source (WebSocket push or RPC poll):
 * an observation is accepted only if its slot is newer than the newest already accepted for that
 * pool. A late RPC answer (slot 98) after a WebSocket update (slot 101) is dropped, as is anything
 * without a slot (it cannot be ordered).
 */
export class SlotGate {
  private readonly last = new Map<string, number>();
  private readonly at = new Map<string, number>(); // wall time of the newest accepted observation

  accept(pool: string, slot: number | undefined, now = Date.now()): boolean {
    if (slot === undefined || !Number.isFinite(slot) || slot <= 0) return false;
    if (slot <= (this.last.get(pool) ?? 0)) return false;
    this.last.set(pool, slot);
    this.at.set(pool, now);
    return true;
  }

  /** ms since the newest accepted observation of the pool (Infinity if none). */
  ageMs(pool: string, now = Date.now()): number {
    const t = this.at.get(pool);
    return t === undefined ? Infinity : now - t;
  }

  /** Newest accepted slot per pool (for health: data age). */
  newest(pool: string): number | undefined {
    return this.last.get(pool);
  }
}
