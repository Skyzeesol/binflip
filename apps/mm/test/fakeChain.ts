/**
 * A small simulated chain for LiveMm tests: position accounts, wallet SOL + tokens, signature
 * outcomes with last-valid heights, a block height, pool liquidity for swaps, and an SDK that can
 * see a different active bin than the one we planned with. Nothing touches the network.
 *
 * Transactions are plain objects; the fake sender applies their effects when they "land".
 * Per-kind behaviours let a test make the next send land normally, land with its reply lost,
 * stay unlanded (pending, then expire), fail, or hang (process crash).
 */
import { PublicKey } from "@solana/web3.js";

export const OWNER = "11111111111111111111111111111111";
export const TOKEN = "TokenMint1111111111111111111111111111111111";
export const WSOL = "So11111111111111111111111111111111111111112";
export const addr = (n: number) => new PublicKey(new Uint8Array(32).fill((n % 250) + 1)).toBase58();

type Kind = "open" | "rebalance" | "close" | "swap";
export type Behaviour = "ok" | "lost" | "pending" | "fail" | "hang" | "landed_hang";
type Tx =
  | { kind: "open"; position: string; pool: string; lower: number; upper: number; lamports: bigint; spend: bigint }
  | { kind: "rebalance"; position: string; lower: number; upper: number }
  | { kind: "close"; position: string }
  | { kind: "swap"; mint: string; amountIn: bigint; route: "jupiter" | "pool" };

interface SigRec {
  status: "confirmed" | "failed" | "processed" | "absent";
  lastValid: number;
  tx: Tx;
  tokenDelta: bigint;
  solDelta: bigint;
}

export class FakeChain {
  height = 1000;
  sol = 10_000_000_000n; // wallet lamports
  tokens = new Map<string, bigint>();
  accounts = new Map<string, { pool: string; lower: number; upper: number; x: bigint; y: bigint }>();
  sigs = new Map<string, SigRec>();
  /** Active bin per pool as the SDK sees it when building (tests may move it under us). */
  active = new Map<string, number>();
  /** Max token a pool swap can take in (partial fills beyond it). */
  poolSwapCapacity = 10n ** 30n;
  binStep = 100;
  /** Behaviour queue per tx kind; empty = "ok". */
  behaviours: Record<Kind, Behaviour[]> = { open: [], rebalance: [], close: [], swap: [] };
  /** Token released by a close (X side of the position). */
  closeReleasesToken = 1000n;
  /** Transient token-balance answers: queue of "error" | "zero" served before the real value. */
  balanceGlitches: Array<"error" | "zero"> = [];
  /** Per-position sends currently between broadcast and outcome, and the max ever seen. */
  inFlightByPosition = new Map<string, number>();
  maxParallelPerPosition = 0;
  /** Every broadcast, in order: kind + position. */
  broadcasts: Array<{ kind: Kind; position?: string }> = [];
  private n = 0;
  holds: Partial<Record<"simulateWithdraw" | "poolInfo" | "open", Array<() => void>>> = {};
  private hold = new Set<string>();

  holdNext(what: "simulateWithdraw" | "poolInfo" | "open"): void {
    this.hold.add(what);
  }
  release(what: "simulateWithdraw" | "poolInfo" | "open"): void {
    this.hold.delete(what);
    for (const r of this.holds[what] ?? []) r();
    this.holds[what] = [];
  }
  /** Every call is held until release(). */
  private async gate(what: "simulateWithdraw" | "poolInfo" | "open"): Promise<void> {
    if (!this.hold.has(what)) return;
    await new Promise<void>((r) => (this.holds[what] ??= []).push(r));
  }

  token(mint: string): bigint {
    return this.tokens.get(mint) ?? 0n;
  }

  // ── builder ──────────────────────────────────────────────────────────────
  builder(mintX = TOKEN) {
    const c = this;
    return {
      connection: {
        getBalance: async () => Number(c.sol),
        getBlockHeight: async () => c.height,
        getAccountInfo: async (pk: PublicKey) => (c.accounts.has(pk.toBase58()) ? { data: Buffer.alloc(0) } : null),
        getMultipleAccountsInfo: async (pks: PublicKey[]) => pks.map((pk) => (c.accounts.has(pk.toBase58()) ? { data: Buffer.alloc(0) } : null)),
        getTransaction: async (sig: string) => {
          const r = c.sigs.get(sig);
          if (!r || (r.status !== "confirmed" && r.status !== "failed")) return null;
          const tb = (n: bigint) => [{ mint: mintX, owner: OWNER, uiTokenAmount: { amount: n.toString() } }];
          return {
            meta: {
              err: r.status === "failed" ? { InstructionError: [0, "Custom"] } : null,
              preTokenBalances: tb(10n ** 12n), postTokenBalances: tb(10n ** 12n + r.tokenDelta),
              preBalances: [Number(10n ** 12n)], postBalances: [Number(10n ** 12n + r.solDelta)],
            },
            transaction: { message: { accountKeys: [new PublicKey(OWNER)] } },
          };
        },
      },
      poolInfo: async (pool: string) => {
        await c.gate("poolInfo");
        return { pool, mintX, mintY: WSOL, binStep: c.binStep, activeBinId: c.active.get(pool) ?? 0, solIsY: true };
      },
      open: async (p: { pool: string; lowerBinId: number; upperBinId: number; amountSol: bigint }) => {
        await c.gate("open");
        const position = addr(++c.n);
        // the SDK clips a SOL-only range to the active bin it sees
        const upper = Math.min(p.upperBinId, c.active.get(p.pool) ?? 0);
        const tx: Tx = { kind: "open", position, pool: p.pool, lower: p.lowerBinId, upper, lamports: p.amountSol, spend: p.amountSol + 60_000_000n };
        return { txs: [tx], extraSigners: new Map(), position, range: { lower: p.lowerBinId, upper } };
      },
      simulateWithdraw: async (_pool: string, position: string) => {
        await c.gate("simulateWithdraw");
        const a = c.accounts.get(position);
        return { x: a?.x ?? 0n, y: a?.y ?? 0n };
      },
      rebalanceOne: async (p: { pool: string; position: string; adds: Array<{ minDeltaId: number; maxDeltaId: number }> }) => {
        const act = c.active.get(p.pool) ?? 0; // the SDK builds against ITS active bin
        const lower = act + Math.min(...p.adds.map((a) => a.minDeltaId));
        const upper = act + Math.max(...p.adds.map((a) => a.maxDeltaId));
        return { txs: [{ kind: "rebalance", position: p.position, lower, upper } as Tx], extraSigners: new Map(), position: p.position, activeId: act };
      },
      remove: async (p: { position: string }) => ({ txs: [{ kind: "close", position: p.position } as Tx], extraSigners: new Map(), position: p.position }),
      positionBins: async (_pool: string, position: string) => {
        const a = c.accounts.get(position);
        if (!a) throw new Error("position not found");
        return { bins: [], lower: a.lower, upper: a.upper, feeX: 0n, feeY: 0n };
      },
      tokenBalance: async (mint: string) => {
        const g = c.balanceGlitches.shift();
        if (g === "error") throw new Error("429 Too Many Requests");
        if (g === "zero") return 0n;
        return c.token(mint);
      },
      swapTokenToSol: async (p: { amount: bigint }) => {
        const take = p.amount < c.poolSwapCapacity ? p.amount : c.poolSwapCapacity; // consumedInAmount
        return { built: { txs: [{ kind: "swap", mint: mintX, amountIn: take, route: "pool" } as Tx], extraSigners: new Map(), position: null }, outLamports: take, minOutLamports: take, impactBps: 0 };
      },
    };
  }

  jupiter(mintX = TOKEN) {
    return {
      quoteToSol: async (_m: string, amount: bigint) => ({ outAmount: String(amount), inAmount: String(amount) }),
      buildSwap: async (q: { inAmount: string }) => ({ tx: { kind: "swap", mint: mintX, amountIn: BigInt(q.inAmount), route: "jupiter" } as Tx, lastValidBlockHeight: this.height + 150 }),
    };
  }

  // ── sender ───────────────────────────────────────────────────────────────
  sender() {
    const c = this;
    const exec = async (tx: Tx, opts: { onSignature?: (s: string, lv: number) => Promise<void> }) => {
      const sig = `${tx.kind}${++c.n}`;
      const lastValid = c.height + 150;
      await opts.onSignature?.(sig, lastValid);
      const pos = "position" in tx ? tx.position : undefined;
      c.broadcasts.push({ kind: tx.kind, position: pos });
      if (pos) {
        const k = (c.inFlightByPosition.get(pos) ?? 0) + 1;
        c.inFlightByPosition.set(pos, k);
        c.maxParallelPerPosition = Math.max(c.maxParallelPerPosition, k);
      }
      const b = c.behaviours[tx.kind].shift() ?? "ok";
      const rec: SigRec = { status: "absent", lastValid, tx, tokenDelta: 0n, solDelta: 0n };
      c.sigs.set(sig, rec);
      const done = () => { if (pos) c.inFlightByPosition.set(pos, (c.inFlightByPosition.get(pos) ?? 1) - 1); };
      if (b === "hang") await new Promise(() => {});
      if (b === "fail") { rec.status = "failed"; done(); throw new Error("transaction failed"); }
      if (b === "pending") { done(); throw new Error("fetch failed (reply lost)"); }
      c.land(sig);
      done();
      if (b === "landed_hang") await new Promise(() => {}); // landed, then the process "crashes"
      if (b === "lost") throw new Error("fetch failed (reply lost)");
      return { signature: sig, slot: c.height, feeLamports: 5000 };
    };
    return {
      send: (tx: Tx, _extra: unknown, opts: { onSignature?: (s: string, lv: number) => Promise<void> } = {}) => exec(tx, opts),
      sendVersioned: (tx: Tx, _lv: number, opts: { onSignature?: (s: string, lv: number) => Promise<void> } = {}) => exec(tx, opts),
      /** SOL the tx would take from the wallet (simulation): opens carry their full spend. */
      estimateSpend: async (tx: Tx) => (tx.kind === "open" ? tx.spend : 10_000n),
      status: async (sig: string) => {
        const s = c.sigs.get(sig)?.status;
        return s === "confirmed" || s === "failed" ? s : "unknown";
      },
      resolve: async (sig: string, lastValid: number | undefined) => {
        const s = c.sigs.get(sig)?.status ?? "absent";
        if (s === "confirmed" || s === "failed") return s;
        if (s === "processed" || lastValid === undefined || c.height <= lastValid) return "pending";
        return "expired";
      },
    };
  }

  /** Make a (pending) signature land now, applying its effects. */
  land(sig: string): void {
    const r = this.sigs.get(sig)!;
    const tx = r.tx;
    r.status = "confirmed";
    if (tx.kind === "open") {
      this.accounts.set(tx.position, { pool: tx.pool, lower: tx.lower, upper: tx.upper, x: 0n, y: tx.lamports });
      this.sol -= tx.spend;
      r.solDelta = -tx.spend;
    } else if (tx.kind === "rebalance") {
      const a = this.accounts.get(tx.position);
      if (a) { a.lower = tx.lower; a.upper = tx.upper; }
    } else if (tx.kind === "close") {
      const a = this.accounts.get(tx.position);
      if (!a) { r.status = "failed"; return; }
      this.accounts.delete(tx.position);
      this.tokens.set(TOKEN, this.token(TOKEN) + this.closeReleasesToken);
      r.tokenDelta = this.closeReleasesToken;
      this.sol += a.y;
      r.solDelta = a.y;
    } else {
      const take = tx.amountIn <= this.token(tx.mint) ? tx.amountIn : this.token(tx.mint);
      this.tokens.set(tx.mint, this.token(tx.mint) - take);
      r.tokenDelta = -take;
      r.solDelta = take; // 1 raw token = 1 lamport in the fake
      this.sol += take;
    }
  }

  /** Signatures of one kind, in order. */
  sigsOf(kind: Kind): string[] {
    return [...this.sigs.entries()].filter(([, r]) => r.tx.kind === kind).map(([s]) => s);
  }
}
