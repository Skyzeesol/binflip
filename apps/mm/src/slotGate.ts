/**
 * One slot order for every pool observation, whatever its source (WebSocket push or RPC poll):
 * an observation is accepted only if its slot is newer than the newest already accepted for that
 * pool. A late RPC answer (slot 98) after a WebSocket update (slot 101) is dropped, as is anything
 * without a slot (it cannot be ordered).
 */
export class SlotGate {
  private readonly last = new Map<string, number>();

  accept(pool: string, slot: number | undefined): boolean {
    if (slot === undefined || !Number.isFinite(slot) || slot <= 0) return false;
    if (slot <= (this.last.get(pool) ?? 0)) return false;
    this.last.set(pool, slot);
    return true;
  }

  /** Newest accepted slot per pool (for health: data age). */
  newest(pool: string): number | undefined {
    return this.last.get(pool);
  }
}
