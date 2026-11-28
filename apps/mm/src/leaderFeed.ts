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
  /** A cheap provider-wide check (e.g. getSlot); throws when the provider itself is down. */
  health?(): Promise<void>;
}
export interface FeedState {
  /** Newest signature fully handled; scanning resumes after it (persisted). */
  cursor?: string;
  /** Recently handled signatures (replay guard after a crash between handle and save). */
  seen: string[];
  /** Signatures that could not be read or handled yet: retried on later polls, never blocking newer ones. */
  retry: Array<{ signature: string; slot: number; tries: number; error?: string }>;
  /**
   * A history scan that needed more pages than one poll may fetch: what was collected so far
   * (newest first) and where paging continues. The cursor does NOT move until the scan has
   * reached it, so nothing between the cursor and the newest signature can be skipped.
   */
  scan?: { collected: SigInfo[]; before: string };
}

/** Raised when the provider itself fails (not one tx): the poll stops, nothing is parked. */
export class ProviderError extends Error {}

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
  /** Consecutive polls that failed because of the provider (health: feed stalled, not one bad tx). */
  providerErrors = 0;

  constructor(
    private readonly rpc: FeedRpc,
    private readonly leader: string,
    private readonly stateFile: string,
    private readonly handle: (tx: NonNullable<Awaited<ReturnType<FeedRpc["getTransaction"]>>>, info: { signature: string; slot: number; late: boolean }) => Promise<void>,
    private readonly opts: { pageSize?: number; maxPages?: number; maxTries?: number; outageAfter?: number; onUnreadable?: (signature: string, tries: number) => void; onGap?: (fetched: number) => void } = {},
  ) {
    if (fs.existsSync(stateFile)) {
      const s = JSON.parse(fs.readFileSync(stateFile, "utf8")) as Partial<FeedState>;
      this.state = { cursor: s.cursor, seen: s.seen ?? [], retry: s.retry ?? [], scan: s.scan };
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
    // 1) everything after the cursor, all pages (newest first from the RPC). A scan that needs
    //    more than maxPages continues on the next poll (and after a restart) from where it stopped.
    const maxPages = this.opts.maxPages ?? 100;
    const all: SigInfo[] = this.state.scan ? [...this.state.scan.collected] : [];
    let before: string | undefined = this.state.scan?.before;
    let complete = false;
    for (let page = 0; page < maxPages; page++) {
      let sigs: SigInfo[];
      try {
        sigs = await this.rpc.getSignaturesForAddress(this.leader, { limit: pageSize, until: this.state.cursor, ...(before ? { before } : {}) });
      } catch (err) {
        this.providerErrors++;
        throw new ProviderError(`signature list: ${(err as Error).message}`);
      }
      all.push(...sigs);
      if (sigs.length < pageSize) { complete = true; break; }
      before = sigs.at(-1)!.signature;
    }
    if (!complete) {
      // not at the cursor yet: keep what we have, continue next poll; the cursor stays put
      this.state.scan = { collected: all, before: before! };
      this.save();
      this.opts.onGap?.(all.length);
      this.providerErrors = 0; // a poll that made progress
      return;
    }
    this.state.scan = undefined;
    const seen = new Set(this.state.seen);
    // A single tx that fails to read or to handle is parked (retried later, never blocking). Several
    // in a row with no success in between look like the PROVIDER failing: those are un-parked, the
    // cursor goes back before them and the poll stops (the health check shows the stalled feed).
    let streak: Array<{ signature: string; cursorBefore?: string }> = [];
    for (const s of all.reverse()) {
      if (!seen.has(s.signature) && !s.err && !this.state.retry.some((r) => r.signature === s.signature)) {
        let failed: string | null = null;
        let tx: Awaited<ReturnType<FeedRpc["getTransaction"]>> = null;
        try {
          tx = await this.rpc.getTransaction(s.signature);
          streak = []; // the provider answered
        } catch (err) {
          failed = `rpc: ${(err as Error).message}`;
          streak.push({ signature: s.signature, cursorBefore: this.state.cursor });
          // Is it the PROVIDER, or just this signature? Ask the provider itself (at once, so a
          // partial outage with few new txs is seen too). Without a health probe: after a streak.
          let providerDown = false;
          if (this.rpc.health) {
            providerDown = !(await this.rpc.health().then(() => true, () => false));
            if (!providerDown) streak = []; // the provider answers: this signature is parked, go on
          } else providerDown = streak.length >= (this.opts.outageAfter ?? 3);
          if (providerDown) {
            const first = streak[0]!;
            const back = new Set(streak.map((x) => x.signature));
            this.state.retry = this.state.retry.filter((r) => !back.has(r.signature));
            this.state.seen = this.state.seen.filter((x) => !back.has(x));
            this.state.cursor = first.cursorBefore;
            this.save();
            this.providerErrors++;
            throw new ProviderError(`${streak.length} transactions in a row failed: ${failed}`);
          }
        }
        if (failed === null) {
          if (!tx || tx.meta === null || tx.meta === undefined) failed = "not readable yet";
          else {
            try {
              await this.handle(tx, { signature: s.signature, slot: s.slot, late: false });
            } catch (err) {
              failed = `handler: ${(err as Error).message}`; // e.g. a decoder error on this one tx: parked, not an outage
            }
          }
        }
        if (failed !== null) this.state.retry.push({ signature: s.signature, slot: s.slot, tries: 1, error: failed.slice(0, 200) });
      }
      this.state.cursor = s.signature;
      this.state.seen.push(s.signature);
      seen.add(s.signature);
      this.save(); // after the tx was handled (or parked for retry)
    }
    // 2) parked ones, oldest first
    for (const r of [...this.state.retry].sort((a, b) => a.slot - b.slot)) {
      let ok = false;
      let tx: Awaited<ReturnType<FeedRpc["getTransaction"]>> = null;
      let rpcFailed = false;
      try {
        tx = await this.rpc.getTransaction(r.signature);
      } catch (err) {
        rpcFailed = true;
        r.error = `rpc: ${(err as Error).message}`.slice(0, 200);
        if (this.rpc.health && !(await this.rpc.health().then(() => true, () => false))) {
          this.save();
          this.providerErrors++;
          throw new ProviderError(`retry read failed and the provider does not answer: ${r.error}`);
        }
      }
      if (tx && tx.meta !== null && tx.meta !== undefined) {
        try {
          await this.handle(tx, { signature: r.signature, slot: r.slot, late: true });
          ok = true;
        } catch (err) {
          r.error = `handler: ${(err as Error).message}`.slice(0, 200); // same queue as RPC errors
        }
      } else if (!rpcFailed) r.error = "not readable yet";
      if (ok) {
        this.state.retry = this.state.retry.filter((x) => x.signature !== r.signature);
      } else if (++r.tries >= (this.opts.maxTries ?? 10)) {
        this.state.retry = this.state.retry.filter((x) => x.signature !== r.signature);
        this.opts.onUnreadable?.(r.signature, r.tries);
      }
      this.save();
    }
    this.providerErrors = 0; // only a fully completed poll resets the outage counter
  }
}
