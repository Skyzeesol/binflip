/**
 * LP Agent "Settings > Security" token filters, applied before a position is
 * opened or copied: Jupiter Organic Score, minimum market cap, minimum 24h
 * volume, minimum holders, and a blacklist. Data comes from Jupiter's token API
 * (the same source as LP Agent's organic score).
 */
export interface TokenInfo {
  mint: string;
  symbol: string | null;
  name?: string | null;
  icon?: string | null;
  decimals?: number | null;
  organicScore: number | null;
  mcapUsd: number | null;
  volume24hUsd: number | null;
  holders: number | null;
  usdPrice: number | null;
  createdAt: Date | null;
}

export interface TokenFilters {
  minOrganicScore: number | null;
  minMarketCapUsd: number | null;
  min24hVolumeUsd: number | null;
  minHolders: number | null;
  minTokenAgeHours: number | null;
  blacklist: string[];
}

export type FilterResult = { ok: true } | { ok: false; reason: "token_blacklisted" | "token_filter"; detail: string };

export function checkTokenFilters(t: TokenInfo, f: TokenFilters, now = new Date()): FilterResult {
  if (f.blacklist.includes(t.mint)) return { ok: false, reason: "token_blacklisted", detail: t.mint };
  const below = (name: string, v: number | null, min: number | null) =>
    min !== null && min > 0 && (v === null || v < min) ? `${name} ${v === null ? "bilinmiyor" : Math.round(v).toLocaleString("en-US")} < ${min.toLocaleString("en-US")}` : null;
  const ageH = t.createdAt ? (now.getTime() - t.createdAt.getTime()) / 3_600_000 : null;
  const fail =
    below("organic score", t.organicScore, f.minOrganicScore) ??
    below("market cap $", t.mcapUsd, f.minMarketCapUsd) ??
    below("24s hacim $", t.volume24hUsd, f.min24hVolumeUsd) ??
    below("holder", t.holders, f.minHolders) ??
    below("yaş (saat)", ageH, f.minTokenAgeHours);
  return fail ? { ok: false, reason: "token_filter", detail: fail } : { ok: true };
}

/** Jupiter token API client with a short cache (filters run on every copied open). */
export class TokenInfoClient {
  private cache = new Map<string, { at: number; info: TokenInfo }>();
  constructor(
    readonly baseUrl = "https://lite-api.jup.ag/tokens/v2",
    readonly ttlMs = 5 * 60_000,
  ) {}

  async get(mint: string): Promise<TokenInfo> {
    const hit = this.cache.get(mint);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.info;
    const res = await fetch(`${this.baseUrl}/search?query=${mint}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`jupiter tokens HTTP ${res.status}`);
    const list = (await res.json()) as Array<Record<string, any>>;
    const t = list.find((x) => x.id === mint);
    const info: TokenInfo = t
      ? {
          mint,
          symbol: t.symbol ?? null,
          name: t.name ?? null,
          icon: typeof t.icon === "string" ? t.icon : null,
          decimals: typeof t.decimals === "number" ? t.decimals : null,
          organicScore: typeof t.organicScore === "number" ? t.organicScore : null,
          mcapUsd: typeof t.mcap === "number" ? t.mcap : null,
          volume24hUsd: t.stats24h ? (t.stats24h.buyVolume ?? 0) + (t.stats24h.sellVolume ?? 0) : null,
          holders: typeof t.holderCount === "number" ? t.holderCount : null,
          usdPrice: typeof t.usdPrice === "number" ? t.usdPrice : null,
          createdAt: t.firstPool?.createdAt ? new Date(t.firstPool.createdAt) : t.createdAt ? new Date(t.createdAt) : null,
        }
      : { mint, symbol: null, organicScore: null, mcapUsd: null, volume24hUsd: null, holders: null, usdPrice: null, createdAt: null };
    this.cache.set(mint, { at: Date.now(), info });
    return info;
  }
}
