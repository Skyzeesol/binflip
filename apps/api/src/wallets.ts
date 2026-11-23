import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Config } from "@binflip/core";
import { schema, type Db } from "@binflip/db";
import { MeteoraData, closedPool, num, openPool } from "./meteora.js";
import { history } from "./portfolioMath.js";

const base58 = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);

/**
 * LP Agent "Portfolio" for any wallet (read-only): the wallet's Meteora DLMM
 * positions from Meteora's data API. Closed positions come aggregated per pool,
 * so win rate and averages here are per pool, not per position.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerWallets(app: FastifyInstance<any, any, any, any>, db: Db, config: Config, meteora: MeteoraData) {
  app.get("/v1/wallets/:address", async (req, reply) => {
    const { address } = z.object({ address: base58 }).parse(req.params);
    const { pages } = z.object({ pages: z.coerce.number().int().min(1).max(10).default(3) }).parse(req.query);
    try {
      const [open, total, ...closedPages] = await Promise.all([
        meteora.walletOpen(address),
        meteora.walletTotal(address),
        ...Array.from({ length: pages }, (_, i) => meteora.walletClosed(address, i + 1).catch(() => ({ pools: [] }))),
      ]);
      const closed = closedPages.flatMap((p) => (p.pools as unknown[] | undefined) ?? []).map((p) => closedPool(p as never));
      const openPools = ((open.pools as unknown[] | undefined) ?? []).map((p) => openPool(p as never));
      const wins = closed.filter((c) => c.pnlSol > 0).length;
      const fees = closed.reduce((s, c) => s + c.feeSol, 0) + openPools.reduce((s, o) => s + o.unclaimedSol, 0);
      const solBalance = await rpcBalance(config.SOLANA_RPC_URL, address).catch(() => null);
      const openValue = num(open.total?.balancesSol);
      const firstClose = closed.reduce<string | null>((m, c) => (c.lastClosedAt && (!m || c.lastClosedAt < m) ? c.lastClosedAt : m), null);
      const months = firstClose ? Math.max(1, (Date.now() - new Date(firstClose).getTime()) / (30 * 86_400_000)) : null;
      const avgWin = wins ? closed.filter((c) => c.pnlSol > 0).reduce((s, c) => s + c.pnlSol, 0) / wins : 0;
      const losses = closed.length - wins;
      const avgLoss = losses ? closed.filter((c) => c.pnlSol <= 0).reduce((s, c) => s + c.pnlSol, 0) / losses : 0;
      const winRate = closed.length ? wins / closed.length : null;
      const [copy] = await db
        .select({ id: schema.leaders.id, label: schema.leaders.label, status: schema.leaders.status })
        .from(schema.leaders)
        .where(and(eq(schema.leaders.userId, req.userId!), eq(schema.leaders.address, address)));
      const sampleProfit = closed.reduce((s, c) => s + c.pnlSol, 0);
      return {
        address,
        copy: copy ?? null,
        summary: {
          netWorth: (solBalance ?? 0) + openValue,
          solBalance,
          openValue,
          openUnclaimed: num(open.total?.unclaimedFeesSol),
          openPnl: num(open.total?.pnlSol),
          totalClosed: num(total.totalClosedPositions),
          totalProfit: num(total.totalPnlSol),
          totalProfitPct: num(total.totalPnlSolPctChange),
          winRate: winRate === null ? null : winRate * 100,
          avgInvested: closed.length ? closed.reduce((s, c) => s + c.depositSol, 0) / closed.length : null,
          feeEarned: fees,
          avgMonthlyProfit: months ? sampleProfit / months : null,
          expectedValue: winRate === null ? null : winRate * avgWin + (1 - winRate) * avgLoss,
          sampledPools: closed.length,
        },
        open: openPools,
        closed,
        days: history(closed.filter((c) => c.lastClosedAt).map((c) => ({ at: new Date(c.lastClosedAt!), value: c.pnlSol })), "day"),
        feeDays: history(closed.filter((c) => c.lastClosedAt).map((c) => ({ at: new Date(c.lastClosedAt!), value: c.feeSol })), "day"),
      };
    } catch (err) {
      return reply.code(502).send({ error: `Meteora verisi alınamadı: ${(err as Error).message}` });
    }
  });
}

async function rpcBalance(url: string, address: string): Promise<number> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [address, { commitment: "confirmed" }] }),
    signal: AbortSignal.timeout(8_000),
  });
  const body = (await res.json()) as { result?: { value: number } };
  return (body.result?.value ?? 0) / 1e9;
}
