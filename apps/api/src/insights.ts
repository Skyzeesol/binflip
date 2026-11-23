import { PublicKey } from "@solana/web3.js";
import { and, desc, eq } from "drizzle-orm";
import {
  DlmmTxBuilder,
  SolanaRpc,
  createConnection,
  decodeMeteoraTx,
  extractActions,
  leaderStats,
  suggestedPercentBps,
  valueInY,
  type Config,
  type LeaderMove,
} from "@binflip/core";
import { schema, type Db } from "@binflip/db";

/**
 * What LP Agent's copy dialog shows before you copy a wallet: the suggested
 * copy % (your net worth ÷ theirs) and the High-frequency warning with the
 * re-add rates that motivate Smart Token Retention.
 */
export class Insights {
  private cache = new Map<string, { at: number; v: unknown }>();
  private builder: DlmmTxBuilder;
  private rpc: SolanaRpc;

  constructor(
    private db: Db,
    config: Config,
  ) {
    this.builder = new DlmmTxBuilder(createConnection(config.SOLANA_RPC_URL), PublicKey.default);
    this.rpc = new SolanaRpc(config.SOLANA_RPC_URL, { retries: 3 });
  }

  async get(userId: string, address: string, mode: "dry_run" | "live") {
    const key = `${userId}:${address}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.v;
    const [leaderNetWorth, ourNetWorth, moves] = await Promise.all([this.walletNetWorth(address), this.ourNetWorth(userId, mode), this.moves(userId, address)]);
    const stats = leaderStats(moves.list);
    const v = {
      leaderNetWorthSol: leaderNetWorth === null ? null : Number(leaderNetWorth) / 1e9,
      ourNetWorthSol: ourNetWorth === null ? null : Number(ourNetWorth) / 1e9,
      suggestedPct: leaderNetWorth && ourNetWorth ? suggestedPercentBps(ourNetWorth, leaderNetWorth) / 100 : null,
      ...stats,
      statsSource: moves.source,
    };
    this.cache.set(key, { at: Date.now(), v });
    return v;
  }

  /** SOL balance + value of open DLMM positions, in lamports. */
  private async walletNetWorth(address: string): Promise<bigint | null> {
    try {
      const owner = new PublicKey(address);
      let total = BigInt(await this.builder.connection.getBalance(owner));
      for (const p of await this.builder.listPositions(owner)) {
        const info = await this.builder.poolInfo(p.pool);
        if (!info.solIsY) continue;
        const pb = await this.builder.positionBins(p.pool, p.position);
        total += BigInt(Math.round(valueInY(pb.bins, info.activeBinId, info.binStep)));
      }
      return total;
    } catch {
      return null;
    }
  }

  private async ourNetWorth(userId: string, mode: "dry_run" | "live"): Promise<bigint | null> {
    const open = await this.db.select().from(schema.positions).where(and(eq(schema.positions.userId, userId), eq(schema.positions.state, "ACTIVE"), eq(schema.positions.dryRun, mode === "dry_run")));
    let total = open.reduce((s, p) => s + BigInt(Math.round(Number(p.currentValueSol ?? 0) * 1e9)), 0n);
    if (mode === "live") {
      const [w] = await this.db.select().from(schema.agentWallets).where(eq(schema.agentWallets.userId, userId));
      if (w) total += BigInt(await this.builder.connection.getBalance(new PublicKey(w.publicKey)).catch(() => 0));
    }
    return total > 0n ? total : null;
  }

  /** Moves we stored for this leader; for a wallet we don't follow yet, its recent chain history. */
  private async moves(userId: string, address: string): Promise<{ list: LeaderMove[]; source: "events" | "chain" | "none" }> {
    const [l] = await this.db.select().from(schema.leaders).where(and(eq(schema.leaders.userId, userId), eq(schema.leaders.address, address)));
    if (l) {
      const ev = await this.db.select().from(schema.leaderEvents).where(eq(schema.leaderEvents.leaderId, l.id)).orderBy(desc(schema.leaderEvents.createdAt)).limit(2000);
      if (ev.length >= 6) {
        return {
          source: "events",
          list: ev.map((e) => ({ kind: (e.payload as { kind: LeaderMove["kind"] }).kind, position: e.leaderPosition ?? "", pool: e.pool, at: e.blockTime ?? e.createdAt })),
        };
      }
    }
    try {
      const sigs = await this.rpc.getSignaturesForAddress(address, { limit: 60 });
      const list: LeaderMove[] = [];
      for (const s of sigs) {
        if (s.err) continue;
        const tx = await this.rpc.getTransaction(s.signature);
        if (!tx) continue;
        for (const a of extractActions(decodeMeteoraTx(tx)).filter((x) => x.owner === address)) {
          list.push({ kind: a.kind, position: a.position, pool: a.pool, at: new Date((tx.blockTime ?? 0) * 1000) });
        }
      }
      return { list, source: list.length ? "chain" : "none" };
    } catch {
      return { list: [], source: "none" };
    }
  }
}
