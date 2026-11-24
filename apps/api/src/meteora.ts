/**
 * Meteora's public data API (dlmm.datapi.meteora.ag / damm-v2.datapi.meteora.ag):
 * pools with volume, fees and Fee/TVL windows, candles, and per-wallet portfolios
 * (open positions per pool, closed positions aggregated per pool, all-time totals).
 * Responses are cached briefly; nothing here signs or holds keys.
 */

const DLMM = "https://dlmm.datapi.meteora.ag";
const DAMM = "https://damm-v2.datapi.meteora.ag";

type Json = Record<string, any>;

export class MeteoraData {
  private cache = new Map<string, { at: number; data: unknown }>();

  private async get<T>(url: string, ttlMs: number): Promise<T> {
    const hit = this.cache.get(url);
    if (hit && Date.now() - hit.at < ttlMs) return hit.data as T;
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    const body = (await res.json().catch(() => ({}))) as Json;
    if (!res.ok) throw new Error(`meteora ${res.status}: ${body.message ?? url}`);
    this.cache.set(url, { at: Date.now(), data: body });
    if (this.cache.size > 2000) this.cache.delete(this.cache.keys().next().value!);
    return body as T;
  }

  /** Pool list. `filter` uses the API's filter_by syntax, e.g. `tvl>10000 && volume_24h>1000`. */
  pools(p: { protocol: "dlmm" | "damm_v2"; page: number; pageSize: number; sort: string; filter?: string; query?: string }) {
    const qs = new URLSearchParams({ page: String(p.page), page_size: String(p.pageSize), sort_by: p.sort });
    if (p.filter) qs.set("filter_by", p.filter);
    if (p.query) qs.set("query", p.query);
    return this.get<{ total: number; pages: number; current_page: number; data: Json[] }>(`${p.protocol === "dlmm" ? DLMM : DAMM}/pools?${qs}`, 60_000);
  }

  pool(address: string, protocol: "dlmm" | "damm_v2" = "dlmm") {
    return this.get<Json>(`${protocol === "dlmm" ? DLMM : DAMM}/pools/${address}`, 15_000);
  }

  /** Candles: 5m, 30m, 1h, 2h, 4h, 12h, 24h. */
  ohlcv(address: string, timeframe: string, protocol: "dlmm" | "damm_v2" = "dlmm") {
    return this.get<{ data: Array<{ timestamp: number; open: number; high: number; low: number; close: number; volume: number }> }>(
      `${protocol === "dlmm" ? DLMM : DAMM}/pools/${address}/ohlcv?timeframe=${timeframe}`,
      30_000,
    );
  }

  walletOpen(user: string) {
    return this.get<Json>(`${DLMM}/portfolio/open?user=${user}`, 20_000);
  }

  /** Closed positions aggregated per pool, newest first, 20 pools a page. */
  walletClosed(user: string, page = 1) {
    return this.get<Json>(`${DLMM}/portfolio?user=${user}&page=${page}`, 60_000);
  }

  walletTotal(user: string) {
    return this.get<Json>(`${DLMM}/portfolio/total?user=${user}`, 60_000);
  }
}

export const num = (v: unknown): number => (v === null || v === undefined || v === "" ? 0 : Number(v));

/** One closed pool row (all positions this wallet closed in that pool). */
export function closedPool(p: Json) {
  return {
    pool: p.poolAddress as string,
    pair: `${p.tokenX}/${p.tokenY}`,
    tokenX: p.tokenX as string,
    tokenY: p.tokenY as string,
    iconX: (p.tokenXIcon as string) || null,
    iconY: (p.tokenYIcon as string) || null,
    mintX: p.tokenXMint as string,
    binStep: num(p.binStep),
    baseFee: num(p.baseFee),
    depositSol: num(p.totalDepositSol),
    withdrawSol: num(p.totalWithdrawalSol),
    feeSol: num(p.totalFeeSol),
    pnlSol: num(p.pnlSol),
    pnlPct: num(p.pnlSolPctChange),
    pnlUsd: num(p.pnlUsd),
    lastClosedAt: p.lastClosedAt ? new Date(num(p.lastClosedAt) * 1000).toISOString() : null,
  };
}

export function openPool(p: Json) {
  return {
    pool: p.poolAddress as string,
    pair: `${p.tokenX}/${p.tokenY}`,
    tokenX: p.tokenX as string,
    tokenY: p.tokenY as string,
    iconX: (p.tokenXIcon as string) || null,
    iconY: (p.tokenYIcon as string) || null,
    mintX: p.tokenXMint as string,
    binStep: num(p.binStep),
    baseFee: num(p.baseFee),
    valueSol: num(p.balancesSol),
    depositSol: num(p.totalDepositSol),
    unclaimedSol: num(p.unclaimedFeesSol),
    pnlSol: num(p.pnlSol),
    pnlPct: num(p.pnlSolPctChange),
    positions: (p.listPositions as string[]) ?? [],
    outOfRange: Boolean(p.outOfRange),
    feePerTvl24h: num(p.feePerTvl24h),
  };
}

/** Pool row for the Pools page (LP Agent columns). */
export function poolRow(p: Json, window: string) {
  const sol = "So11111111111111111111111111111111111111112";
  const x = p.token_x ?? {};
  const y = p.token_y ?? {};
  const base = x.address === sol ? y : x;
  const quote = x.address === sol ? x : y;
  const w = (o: Json | undefined) => num(o?.[window]);
  return {
    address: p.address as string,
    name: p.name as string,
    base: { mint: base.address, symbol: base.symbol, name: base.name, icon: base.icon ?? null, holders: num(base.holders), mcap: num(base.market_cap), price: num(base.price), verified: Boolean(base.is_verified), freezeDisabled: Boolean(base.freeze_authority_disabled), decimals: num(base.decimals) },
    quote: { mint: quote.address, symbol: quote.symbol, icon: quote.icon ?? null },
    solIsX: x.address === sol,
    binStep: num(p.pool_config?.bin_step),
    baseFeePct: num(p.pool_config?.base_fee_pct),
    tvl: num(p.tvl),
    volume: w(p.volume),
    fees: w(p.fees),
    // Meteora's fee_tvl_ratio is already a percentage (fees / TVL × 100 over the window).
    feeTvl: w(p.fee_tvl_ratio),
    feeTvlAll: { "30m": num(p.fee_tvl_ratio?.["30m"]), "1h": num(p.fee_tvl_ratio?.["1h"]), "4h": num(p.fee_tvl_ratio?.["4h"]), "24h": num(p.fee_tvl_ratio?.["24h"]) },
    dynamicFeePct: p.dynamic_fee_pct === undefined || p.dynamic_fee_pct === null ? null : num(p.dynamic_fee_pct),
    apr: num(p.apr),
    price: num(p.current_price),
    createdAt: p.created_at ? new Date(num(p.created_at)).toISOString() : null,
    launchpad: (p.launchpad as string) || null,
    blacklisted: Boolean(p.is_blacklisted),
  };
}

/**
 * Jupiter token data (organic score, total liquidity across DEXes) for a list of
 * mints, cached 2 minutes. Used to enrich pool rows; failures just leave gaps.
 */
const jupCache = new Map<string, { at: number; t: Json }>();
export async function jupTokens(mints: string[]): Promise<Map<string, Json>> {
  const out = new Map<string, Json>();
  const need = [...new Set(mints)].filter((m) => {
    const hit = jupCache.get(m);
    if (hit && Date.now() - hit.at < 120_000) return out.set(m, hit.t), false;
    return true;
  });
  for (let i = 0; i < need.length; i += 50) {
    const res = await fetch(`https://lite-api.jup.ag/tokens/v2/search?query=${need.slice(i, i + 50).join(",")}`, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
    const list = res?.ok ? ((await res.json().catch(() => [])) as Json[]) : [];
    for (const t of list) {
      jupCache.set(String(t.id), { at: Date.now(), t });
      out.set(String(t.id), t);
    }
  }
  if (jupCache.size > 5000) jupCache.clear();
  return out;
}
