import { createHash } from "node:crypto";
import bs58 from "bs58";
import { lt, sql } from "drizzle-orm";
import { PROGRAM_IDS, type Logger } from "@binflip/core";
import { schema, type Db } from "@binflip/db";

/**
 * Smart LP index (LP Agent "Smart LP"): find wallets that LP in the busiest
 * Meteora DLMM SOL pools right now (position owners read from chain), then score
 * each one from Meteora's public portfolio data (all-time PnL, closed pools,
 * fees). Win rate and averages are per pool, which is what that data gives.
 */
const DLMM_API = "https://dlmm.datapi.meteora.ag";
const SOL = "So11111111111111111111111111111111111111112";
const POSITION_V2 = bs58.encode(createHash("sha256").update("account:PositionV2").digest().subarray(0, 8));

type Json = Record<string, any>;

async function getJson(url: string): Promise<Json> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return (await res.json()) as Json;
}

export async function ownersOf(rpcUrl: string, pool: string, attempt = 0): Promise<string[]> {
  try {
    return await ownersOnce(rpcUrl, pool);
  } catch (err) {
    // RPCs rate-limit getProgramAccounts; back off and retry a few times.
    if (attempt >= 3 || !/too many|429|rate/i.test((err as Error).message)) throw err;
    await new Promise((r) => setTimeout(r, 2_000 * 2 ** attempt));
    return ownersOf(rpcUrl, pool, attempt + 1);
  }
}

async function ownersOnce(rpcUrl: string, pool: string): Promise<string[]> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getProgramAccounts",
      params: [PROGRAM_IDS.DLMM, { encoding: "base64", dataSlice: { offset: 40, length: 32 }, filters: [{ memcmp: { offset: 0, bytes: POSITION_V2 } }, { memcmp: { offset: 8, bytes: pool } }] }],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json()) as { result?: Array<{ account: { data: [string, string] } }>; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return [...new Set((body.result ?? []).map((a) => bs58.encode(Buffer.from(a.account.data[0], "base64"))))];
}

export interface WalletScore {
  address: string;
  totalPnlSol: number;
  winRate: number | null;
  closedPositions: number;
  feesSol: number;
  pnl7dSol: number;
  pnl30dSol: number;
  monthlySol: number | null;
  evSol: number | null;
  avgInvestedSol: number | null;
  openValueSol: number;
  feeChecked: boolean;
  lastActiveAt: Date | null;
  openPools: string[];
  openTokens: string[];
  daily: Array<{ day: string; pnl: number }>;
  sampledPools: number;
}

/** Pure scoring from Meteora's portfolio responses (tested). */
export function scoreWallet(address: string, total: Json, closedPages: Json[], open: Json, now = Date.now()): WalletScore {
  const closed = closedPages.flatMap((p) => (p.pools as Json[] | undefined) ?? []);
  const pnl = (c: Json) => Number(c.pnlSol ?? 0);
  const at = (c: Json) => (c.lastClosedAt ? Number(c.lastClosedAt) * 1000 : 0);
  const wins = closed.filter((c) => pnl(c) > 0);
  const losses = closed.filter((c) => pnl(c) <= 0);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const winRate = closed.length ? wins.length / closed.length : null;
  const fees = closed.reduce((s, c) => s + Number(c.totalFeeSol ?? 0), 0);
  const sampleProfit = closed.reduce((s, c) => s + pnl(c), 0);
  const first = closed.reduce((m, c) => (at(c) && (!m || at(c) < m) ? at(c) : m), 0);
  const last = closed.reduce((m, c) => Math.max(m, at(c)), 0);
  const openPools = ((open.pools as Json[] | undefined) ?? []);
  const lastOpen = openPools.reduce((m, p) => Math.max(m, Number(p.updatedAt ?? 0) * 1000), 0);
  const months = first ? Math.max(1, (now - first) / (30 * 86_400_000)) : null;
  const byDay = new Map<string, number>();
  for (const c of closed) {
    if (!at(c) || now - at(c) > 7 * 86_400_000) continue;
    const d = new Date(at(c)).toISOString().slice(0, 10);
    byDay.set(d, (byDay.get(d) ?? 0) + pnl(c));
  }
  const totalPnl = Number(total.totalPnlSol ?? 0);
  return {
    address,
    totalPnlSol: totalPnl,
    winRate: winRate === null ? null : winRate * 100,
    closedPositions: Number(total.totalClosedPositions ?? 0),
    feesSol: fees,
    pnl7dSol: closed.filter((c) => now - at(c) <= 7 * 86_400_000).reduce((s, c) => s + pnl(c), 0),
    pnl30dSol: closed.filter((c) => now - at(c) <= 30 * 86_400_000).reduce((s, c) => s + pnl(c), 0),
    monthlySol: months ? sampleProfit / months : null,
    evSol: winRate === null ? null : winRate * avg(wins.map(pnl)) + (1 - winRate) * avg(losses.map(pnl)),
    avgInvestedSol: closed.length ? avg(closed.map((c) => Number(c.totalDepositSol ?? 0))) : null,
    openValueSol: Number(open.total?.balancesSol ?? 0),
    // LP Agent: if LP fees are under 10% of the profit, the profit came from token price, not LPing.
    feeChecked: sampleProfit <= 0 || fees >= 0.1 * sampleProfit,
    lastActiveAt: Math.max(last, lastOpen) ? new Date(Math.max(last, lastOpen)) : null,
    openPools: openPools.map((p) => String(p.poolAddress)),
    openTokens: [...new Set(openPools.map((p) => String(p.tokenXMint === SOL ? p.tokenYMint : p.tokenXMint)))],
    daily: [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, v]) => ({ day, pnl: v })),
    sampledPools: closed.length,
  };
}

export class SmartLpIndexer {
  private running = false;
  constructor(
    private readonly db: Db,
    private readonly rpcUrl: string,
    private readonly log: Logger,
    private readonly opts = { pools: 40, wallets: 300, concurrency: 4 },
  ) {}

  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const t0 = Date.now();
    try {
      // The busiest SOL pools: best Fee/TVL and the most volume, with real liquidity.
      const lists = await Promise.all([
        getJson(`${DLMM_API}/pools?page_size=${this.opts.pools}&sort_by=fee_tvl_ratio_24h:desc&filter_by=${encodeURIComponent(`tvl>20000 && token_y=${SOL}`)}`),
        getJson(`${DLMM_API}/pools?page_size=${Math.ceil(this.opts.pools / 2)}&sort_by=volume_24h:desc&filter_by=${encodeURIComponent(`tvl>20000 && token_y=${SOL}`)}`),
      ]);
      const pools = [...new Set(lists.flatMap((l) => ((l.data as Json[]) ?? []).map((p) => String(p.address))))];
      const seen = new Map<string, number>();
      for (const pool of pools) {
        try {
          for (const o of await ownersOf(this.rpcUrl, pool)) seen.set(o, (seen.get(o) ?? 0) + 1);
        } catch (err) {
          this.log.warn({ pool, err: (err as Error).message }, "smart lp: owners read failed");
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      // Wallets active in several of these pools first.
      const candidates = [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, this.opts.wallets).map(([a]) => a);
      let done = 0;
      const queue = [...candidates];
      const worker = async () => {
        for (let a = queue.shift(); a; a = queue.shift()) {
          try {
            const [total, open, p1, p2] = await Promise.all([
              getJson(`${DLMM_API}/portfolio/total?user=${a}`),
              getJson(`${DLMM_API}/portfolio/open?user=${a}`),
              getJson(`${DLMM_API}/portfolio?user=${a}&page=1`),
              getJson(`${DLMM_API}/portfolio?user=${a}&page=2`).catch(() => ({ pools: [] })),
            ]);
            const s = scoreWallet(a, total, [p1, p2], open);
            const row = {
              address: s.address,
              totalPnlSol: String(s.totalPnlSol),
              winRate: s.winRate === null ? null : String(s.winRate),
              closedPositions: s.closedPositions,
              feesSol: String(s.feesSol),
              pnl7dSol: String(s.pnl7dSol),
              pnl30dSol: String(s.pnl30dSol),
              monthlySol: s.monthlySol === null ? null : String(s.monthlySol),
              evSol: s.evSol === null ? null : String(s.evSol),
              avgInvestedSol: s.avgInvestedSol === null ? null : String(s.avgInvestedSol),
              openValueSol: String(s.openValueSol),
              feeChecked: s.feeChecked,
              lastActiveAt: s.lastActiveAt,
              openPools: s.openPools,
              openTokens: s.openTokens,
              daily: s.daily,
              sampledPools: s.sampledPools,
            };
            await this.db.insert(schema.smartWallets).values(row).onConflictDoUpdate({ target: schema.smartWallets.address, set: { ...row, updatedAt: new Date() } });
            done++;
          } catch (err) {
            this.log.debug({ wallet: a, err: (err as Error).message }, "smart lp: wallet score failed");
          }
        }
      };
      await Promise.all(Array.from({ length: this.opts.concurrency }, worker));
      // Wallets not seen for 3 days drop out of the list.
      await this.db.delete(schema.smartWallets).where(lt(schema.smartWallets.updatedAt, sql`now() - interval '3 days'`));
      this.log.info({ pools: pools.length, candidates: candidates.length, scored: done, ms: Date.now() - t0 }, "smart lp index refreshed");
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, "smart lp index failed");
    } finally {
      this.running = false;
    }
  }
}
