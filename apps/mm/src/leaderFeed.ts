import fs from "node:fs";

export interface SigInfo {
  signature: string;
  slot: number;
  err: unknown;
  blockTime?: number | null;
}
export interface FeedRpc {
  getSignaturesForAddress(address: string, opts: { limit: number; before?: string; until?: string }): Promise<SigInfo[]>;
  /** null (not visible yet) or a tx without meta are both "unreadable for now". */
  getTransaction(signature: string): Promise<{ meta: unknown | null; slot: number; blockTime?: number | null } | null>;
}
export interface FeedState {
  /** Newest signature fully handled; scanning resumes after it (persisted). */
  cursor?: string;
  /** Recently handled signatures (replay guard after a crash between handle and save). */
  seen: string[];
  /** Signatures that could not be read yet: retried on later polls, never blocking newer ones. */
  retry: Array<{ signature: string; slot: number; tries: number }>;
}

/**
 * The leader's transactions, oldest first, without losing any:
 *  - the cursor and a replay guard are persisted; a restart resumes after the last HANDLED tx,
 *    so closes during downtime are seen;
 *  - history is paged backwards (`before`) down to the cursor, so a burst of more than one page
 *    (e.g. 220 txs) is read completely;
 *  - progress is saved after each handled tx (the handler persists its own effects first);
 *  - a tx that cannot be read (null, or meta null) does not block newer ones: it is retried on
 *    later polls (`late: true`) and after `maxTries` reported through onUnreadable, so the
 *    caller can reconcile affected positions from chain.
 */
export class LeaderFeed {
  state: FeedState = { seen: [], retry: [] };

  constructor(
    private readonly rpc: FeedRpc,
    private readonly leader: string,
    private readonly stateFile: string,
    private readonly handle: (tx: NonNullable<Awaited<ReturnType<FeedRpc["getTransaction"]>>>, info: { signature: string; slot: number; late: boolean }) => Promise<void>,
    private readonly opts: { pageSize?: number; maxPages?: number; maxTries?: number; onUnreadable?: (signature: string, tries: number) => void; onGap?: (fetched: number) => void } = {},
  ) {
    if (fs.existsSync(stateFile)) {
      const s = JSON.parse(fs.readFileSync(stateFile, "utf8")) as Partial<FeedState>;
      this.state = { cursor: s.cursor, seen: s.seen ?? [], retry: s.retry ?? [] };
    }
  }

  private save(): void {
    if (this.state.seen.length > 5000) this.state.seen = this.state.seen.slice(-5000);
    fs.writeFileSync(this.stateFile + ".tmp", JSON.stringify(this.state));
    fs.renameSync(this.stateFile + ".tmp", this.stateFile);
  }

  async poll(): Promise<void> {
    const pageSize = this.opts.pageSize ?? 200;
    if (!this.state.cursor) {
      // first start ever: begin from "now" (open positions are adopted on their next rebalance)
      const [newest] = await this.rpc.getSignaturesForAddress(this.leader, { limit: 1 });
      if (newest) {
        this.state.cursor = newest.signature;
        this.save();
      }
      return;
    }
    // 1) everything after the cursor, all pages (newest first from the RPC)
    const all: SigInfo[] = [];
    let before: string | undefined;
    for (let page = 0; page < (this.opts.maxPages ?? 100); page++) {
      const sigs = await this.rpc.getSignaturesForAddress(this.leader, { limit: pageSize, until: this.state.cursor, ...(before ? { before } : {}) });
      all.push(...sigs);
      if (sigs.length < pageSize) break;
      before = sigs.at(-1)!.signature;
      if (page === (this.opts.maxPages ?? 100) - 1) this.opts.onGap?.(all.length); // more than we page through: say so
    }
    const seen = new Set(this.state.seen);
    for (const s of all.reverse()) {
      if (!seen.has(s.signature) && !s.err && !this.state.retry.some((r) => r.signature === s.signature)) {
        const tx = await this.rpc.getTransaction(s.signature); // throws → cursor stays, retried next poll
        if (!tx || tx.meta === null || tx.meta === undefined) this.state.retry.push({ signature: s.signature, slot: s.slot, tries: 1 });
        else await this.handle(tx, { signature: s.signature, slot: s.slot, late: false });
      }
      this.state.cursor = s.signature;
      this.state.seen.push(s.signature);
      seen.add(s.signature);
      this.save(); // after the tx was handled (or parked for retry)
    }
    // 2) parked ones, oldest first
    for (const r of [...this.state.retry].sort((a, b) => a.slot - b.slot)) {
      const tx = await this.rpc.getTransaction(r.signature).catch(() => null);
      if (tx && tx.meta !== null && tx.meta !== undefined) {
        await this.handle(tx, { signature: r.signature, slot: r.slot, late: true });
        this.state.retry = this.state.retry.filter((x) => x.signature !== r.signature);
      } else if (++r.tries >= (this.opts.maxTries ?? 10)) {
        this.state.retry = this.state.retry.filter((x) => x.signature !== r.signature);
        this.opts.onUnreadable?.(r.signature, r.tries);
      }
      this.save();
    }
  }
}
