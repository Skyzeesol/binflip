"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { compact } from "@/components/Num";
import { short } from "@/lib/format";
import { ageOfIso, ageShort, Chg, ColumnsPicker, CopyBtn, FilterIcon, Leaf, Price, Spark, TokenIcon, Updated, usd, useColumns } from "@/components/market";

type Preset = "trending" | "new" | "graduated" | "fee_tvl" | "rising" | "smart" | "nopool";
type Win = "30m" | "1h" | "4h" | "24h";
interface PoolLite { address: string; name: string; binStep: number; baseFee: number; tvl: number; volume24h: number; fees24h: number; feeTvl: Record<Win, number>; feeTvlChange: Record<Win, number | null> }
interface Token {
  mint: string; symbol: string; name: string; icon: string | null; launchpad: string | null; verified: boolean;
  ageH: number | null; graduatedAt: string | null; price: number; priceChange24h: number; spark: number[]; mcap: number; holders: number;
  volume24h: number; volume5m: number; volumeChange5m: number | null; volumeChange1h: number; volumeChange24h: number;
  organicScore: number | null; top10Pct: number | null; devPct: number | null;
  mintRevoked: boolean; freezeRevoked: boolean; safety: number | null; safetyLabel: "safe" | "caution" | "risky" | null;
  smartLps: number; pools: number; liquidity: number;
  bestPool: { address: string; feeTvl: Record<Win, number>; feeTvlChange: Record<Win, number | null>; binStep: number; tvl: number } | null;
  poolList: PoolLite[];
}
interface Res { preset: Preset; floor: string | null; updatedAt: string; rows: Token[] }

// Tab names stay as in LP Agent; the hint explains each in Turkish.
const PRESETS: Array<{ id: Preset; label: string; hint: string }> = [
  { id: "trending", label: "Trending", hint: "Bu saatin hacmi bir önceki saate göre en çok artanlar (1 saatlik hacmi $10k üstü)." },
  { id: "new", label: "New", hint: "En yeni tokenler önce." },
  { id: "graduated", label: "Graduated", hint: "Launchpad'den (bonding curve) çıkıp havuza geçen tokenler, en yeni önce." },
  { id: "fee_tvl", label: "Top Fee/TVL", hint: "Havuzları likiditesine göre en çok fee kazandıran tokenler (son 1 saat)." },
  { id: "rising", label: "Rising fees", hint: "Son 30 dakikanın Fee/TVL'si bir önceki 30 dakikaya göre en çok artanlar." },
  { id: "smart", label: "Smart money in", hint: "Havuzlarında en çok Smart LP pozisyonu olan tokenler." },
  { id: "nopool", label: "No Pool", hint: "Hacmi olan ama listelenecek Meteora havuzu henüz olmayan tokenler." },
];
const SAFETY_EN = { safe: "Safe", caution: "Caution", risky: "Risky" } as const;

type Col = "age" | "price" | "mcap" | "holders" | "vol5m" | "vol24h" | "liq" | "feetvl" | "ft24h" | "safety" | "smart" | "volchg1h";
const COLS: ReadonlyArray<{ id: Col; label: string; on: boolean }> = [
  { id: "age", label: "Age", on: true },
  { id: "price", label: "Price 24H", on: true },
  { id: "mcap", label: "MCAP", on: true },
  { id: "holders", label: "Holders", on: true },
  { id: "vol5m", label: "Vol 5M", on: true },
  { id: "liq", label: "Liquidity", on: true },
  { id: "feetvl", label: "Fee/TVL", on: true },
  { id: "ft24h", label: "Fee/TVL 24H", on: true },
  { id: "safety", label: "Safety", on: true },
  { id: "smart", label: "Smart LP", on: false },
  { id: "vol24h", label: "Vol 24H", on: false },
  { id: "volchg1h", label: "Vol change 1H", on: false },
];

interface Filters { minMcap: string; maxMcap: string; minLiquidity: string; minVolume: string; minHolders: string; maxAgeH: string }
const NOF: Filters = { minMcap: "", maxMcap: "", minLiquidity: "", minVolume: "", minHolders: "", maxAgeH: "" };

/** LP Agent "Discover": pick the token first (volume, Fee/TVL, safety, smart LPs), then its best pool. */
export default function DiscoverPage() {
  const [preset, setPreset] = useState<Preset>("trending");
  const [hideRisky, setHideRisky] = useState(true);
  const [win, setWin] = useState<Win>("1h");
  const [q, setQ] = useState("");
  const [f, setF] = useState<Filters>(NOF);
  const [d, setD] = useState<Res | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [sort, setSort] = useState<{ k: string; dir: 1 | -1 } | null>(null);
  const cols = useColumns<Col>("binflip.discoverCols", COLS);

  useEffect(() => {
    try {
      const s = JSON.parse(localStorage.getItem("binflip.discover") ?? "{}") as { preset?: Preset; hideRisky?: boolean; win?: Win; f?: Filters };
      if (s.preset && PRESETS.some((p) => p.id === s.preset)) setPreset(s.preset);
      if (s.hideRisky !== undefined) setHideRisky(s.hideRisky);
      if (s.win) setWin(s.win);
      if (s.f) setF({ ...NOF, ...s.f });
    } catch {
      /* storage blocked */
    }
  }, []);
  const load = useCallback(() => {
    const qs = new URLSearchParams({ preset, hideRisky: String(hideRisky) });
    if (q.trim()) qs.set("q", q.trim());
    for (const [k, v] of Object.entries(f)) if (v !== "") qs.set(k, v);
    void api<Res>(`/v1/discover?${qs}`).then((r) => (setD(r), setErr(null))).catch((e) => setErr((e as Error).message));
    try {
      localStorage.setItem("binflip.discover", JSON.stringify({ preset, hideRisky, win, f }));
    } catch {
      /* storage blocked */
    }
  }, [preset, hideRisky, q, f, win]);
  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  const val = (t: Token, k: string): number =>
    k === "age" ? -(t.ageH ?? 1e9) : k === "price" ? t.priceChange24h : k === "mcap" ? t.mcap : k === "holders" ? t.holders : k === "vol5m" ? t.volume5m : k === "vol24h" ? t.volume24h : k === "volchg1h" ? t.volumeChange1h : k === "liq" ? t.liquidity : k === "feetvl" ? (t.bestPool?.feeTvl[win] ?? 0) : k === "ft24h" ? (t.bestPool?.feeTvl["24h"] ?? 0) : k === "safety" ? (t.safety ?? -1) : k === "smart" ? t.smartLps : 0;
  const rows = sort && d ? [...d.rows].sort((a, b) => (val(a, sort.k) - val(b, sort.k)) * sort.dir) : (d?.rows ?? []);
  const th = (k: Col, label: React.ReactNode, extra = "") =>
    cols.has(k) && (
      <th className={`num sortable ${sort?.k === k ? "sorted" : ""} ${extra}`} onClick={() => setSort((s) => ({ k, dir: s?.k === k && s.dir === -1 ? 1 : -1 }))}>
        {sort?.k === k ? (sort.dir === -1 ? "↓ " : "↑ ") : ""}
        {label}
      </th>
    );
  const nCols = 2 + cols.shown.size;
  const activeF = Object.values(f).filter((v) => v !== "").length;

  return (
    <main className="page page-full" lang="en">
      <div className="mk-bar">
        <div className="mk-tabs">
          {PRESETS.map((p) => <button key={p.id} className={preset === p.id ? "on" : ""} title={p.hint} onClick={() => (setPreset(p.id), setSort(null))}>{p.label}</button>)}
        </div>
        <div className="spacer" />
        <FiltersPop f={f} setF={setF} active={activeF} />
        <ColumnsPicker all={COLS} shown={cols.shown} toggle={cols.toggle} />
        <label className="tool-btn btn btn-sm"><button className={`switch sm ${hideRisky ? "on" : ""}`} onClick={() => setHideRisky(!hideRisky)} aria-pressed={hideRisky} />Hide risky</label>
      </div>

      {err && <div className="banner banner-neg">{err}</div>}
      <div className="card mk-card">
        <div className="mk-head">
          <div><b>{rows.length.toLocaleString("en-US")} tokens</b> <span className="muted">on Solana</span></div>
          <form className="mk-search" onSubmit={(e) => (e.preventDefault(), load())}>
            <input type="text" placeholder="Token adı ya da adresi" value={q} onChange={(e) => setQ(e.target.value)} />
          </form>
          <div className="spacer" />
          <Updated at={d?.updatedAt} />
        </div>
        <div className="small muted mk-hint">{PRESETS.find((p) => p.id === preset)?.hint}</div>
        <div className="table-wrap">
          <table className="mk-table">
            <thead>
              <tr>
                <th>Token</th>
                {th("age", "Age")}
                {th("price", "Price 24H")}
                {th("mcap", "MCAP")}
                {th("holders", "Holders")}
                {th("vol5m", "Vol 5M")}
                {th("vol24h", "Vol 24H")}
                {th("volchg1h", "Vol chg 1H")}
                {th("liq", "Liquidity")}
                {cols.has("feetvl") && (
                  <th className={`num sortable ${sort?.k === "feetvl" ? "sorted" : ""}`}>
                    <span onClick={() => setSort((s) => ({ k: "feetvl", dir: s?.k === "feetvl" && s.dir === -1 ? 1 : -1 }))}>{sort?.k === "feetvl" ? (sort.dir === -1 ? "↓ " : "↑ ") : ""}Fee/TVL</span>{" "}
                    <select className="th-sel" value={win} onChange={(e) => setWin(e.target.value as Win)} onClick={(e) => e.stopPropagation()}>
                      {(["30m", "1h", "4h", "24h"] as const).map((w) => <option key={w} value={w}>{w.toUpperCase()}</option>)}
                    </select>
                  </th>
                )}
                {th("ft24h", "24H")}
                {th("safety", "Safety", "center")}
                {th("smart", "Smart LP")}
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <Fragment key={t.mint}>
                  <tr className="clickable" onClick={() => setOpen(open === t.mint ? null : t.mint)}>
                    <td>
                      <div className="tok">
                        <span className={`caret ${open === t.mint ? "open" : ""}`}>›</span>
                        <TokenIcon icon={t.icon} symbol={t.symbol} />
                        <div className="tok-text">
                          <div className="tok-top"><b>{t.symbol}</b>{t.verified && <span className="pos small" title="Verified">✓</span>}<span className="muted small">{t.pools ? `${t.pools >= 10 ? "10+" : t.pools} pool` : "no pool"}</span></div>
                          <div className="tok-sub"><span className="muted">{t.name?.slice(0, 18)}</span><CopyBtn text={t.mint} />{t.launchpad && <span className="lp-tag">{t.launchpad}</span>}</div>
                        </div>
                      </div>
                    </td>
                    {cols.has("age") && <td className="num">{preset === "graduated" && t.graduatedAt ? <span title="Graduated">{ageOfIso(t.graduatedAt)}</span> : ageShort(t.ageH)}</td>}
                    {cols.has("price") && (
                      <td className="num">
                        <div className="price-cell">
                          <Spark points={t.spark} />
                          <div><Price v={t.price} /><Chg v={t.priceChange24h} /></div>
                        </div>
                      </td>
                    )}
                    {cols.has("mcap") && <td className="num">{usd(t.mcap)}</td>}
                    {cols.has("holders") && <td className="num">{t.holders >= 1000 ? compact(t.holders, 1) : t.holders}</td>}
                    {cols.has("vol5m") && <td className="num">{usd(t.volume5m)}<Chg v={t.volumeChange5m} /></td>}
                    {cols.has("vol24h") && <td className="num">{usd(t.volume24h)}<Chg v={t.volumeChange24h} /></td>}
                    {cols.has("volchg1h") && <td className="num"><Chg v={t.volumeChange1h} /></td>}
                    {cols.has("liq") && <td className="num">{t.liquidity ? usd(t.liquidity) : "—"}</td>}
                    {cols.has("feetvl") && <td className="num"><span className="pos strong">{t.bestPool ? `${t.bestPool.feeTvl[win].toFixed(2)}%` : "—"}</span>{t.bestPool && <Chg v={t.bestPool.feeTvlChange[win]} />}</td>}
                    {cols.has("ft24h") && <td className="num">{t.bestPool ? `${t.bestPool.feeTvl["24h"].toFixed(1)}%` : "—"}<Chg v={null} /></td>}
                    {cols.has("safety") && (
                      <td className="num">
                        <div className="safety-cell">
                          <div className="safety-top">
                            <Leaf score={t.organicScore} />
                            {t.safety !== null && (
                              <span className={`safety safety-${t.safetyLabel}`} title={`Mint authority: ${t.mintRevoked ? "revoked" : "VAR"} · Freeze authority: ${t.freezeRevoked ? "revoked" : "VAR"} · Top 10 holder: ${t.top10Pct?.toFixed(1) ?? "—"}% · Holders: ${t.holders}`}>
                                {SAFETY_EN[t.safetyLabel!]} {t.safety}
                              </span>
                            )}
                          </div>
                          <div className="muted small">{t.top10Pct !== null ? `Top10 ${t.top10Pct.toFixed(0)}%` : ""}{t.devPct !== null && t.devPct !== undefined ? ` · Dev ${t.devPct.toFixed(1)}%` : ""}</div>
                        </div>
                      </td>
                    )}
                    {cols.has("smart") && <td className="num">{t.smartLps || "—"}</td>}
                    <td onClick={(e) => e.stopPropagation()}>
                      {t.bestPool ? <Link className="btn btn-sm btn-open" href={`/pools/${t.bestPool.address}?protocol=dlmm`}>Open pool →</Link> : <a className="btn btn-sm" href={`https://app.meteora.ag/dlmm/create-pool?baseMint=${t.mint}`} target="_blank" rel="noreferrer">Create pool ↗</a>}
                    </td>
                  </tr>
                  {open === t.mint && (
                    <tr className="disc-pools">
                      <td colSpan={nCols}>
                        {t.poolList.length ? (
                          <table>
                            <thead><tr><th>Pool</th><th className="num">Liquidity</th><th className="num">Volume 24H</th><th className="num">Fees 24H</th><th className="num">Fee/TVL 30M</th><th className="num">1H</th><th className="num">4H</th><th className="num">24H</th><th /></tr></thead>
                            <tbody>
                              {[...t.poolList].sort((a, b) => b.feeTvl["1h"] - a.feeTvl["1h"]).map((p, i) => (
                                <tr key={p.address}>
                                  <td>{p.name} <span className="muted small">bin {p.binStep} · fee {p.baseFee}% · {short(p.address, 4)}</span>{i === 0 && <span className="src src-auto" style={{ marginLeft: 6 }}>Best Fee/TVL</span>}</td>
                                  <td className="num">{usd(p.tvl)}</td>
                                  <td className="num">{usd(p.volume24h)}</td>
                                  <td className="num">{usd(p.fees24h)}</td>
                                  {(["30m", "1h", "4h", "24h"] as const).map((w) => <td key={w} className="num pos">{p.feeTvl[w].toFixed(2)}%</td>)}
                                  <td><Link className="btn btn-sm" href={`/pools/${p.address}?protocol=dlmm`}>Open</Link></td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        ) : (
                          <div className="muted small">Bu tokenin listelenecek Meteora DLMM havuzu yok.</div>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {d && !rows.length && <tr><td colSpan={nCols} className="empty">Bu listede token yok.</td></tr>}
              {!d && !err && <tr><td colSpan={nCols} className="empty">Yükleniyor…</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      <p className="small muted">İpucu: Fee/TVL'si çok yüksek ama "Risky" görünen bir token genelde yüksekliğin sebebidir. Safety puanı Binflip'in kendi hesabıdır (mint/freeze yetkisi, ilk 10 holder, organic score, holder sayısı). Fee/TVL altındaki değişim, bir önceki aynı uzunluktaki pencereye göredir. Fiyat çizgisi 24s / 6s / 1s / 5dk değişimlerinden çizilir.</p>
    </main>
  );
}

function FiltersPop({ f, setF, active }: { f: Filters; setF: (f: Filters) => void; active: number }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Filters>(f);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const conv = (v: string) => {
    const m = v.trim().toLowerCase().match(/^([\d.]+)\s*([kmb])?$/);
    if (!m) return "";
    return String(Number(m[1]) * (m[2] === "k" ? 1e3 : m[2] === "m" ? 1e6 : m[2] === "b" ? 1e9 : 1));
  };
  const field = (k: keyof Filters, label: string) => <label className="field small">{label}<input type="text" value={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} /></label>;
  return (
    <div className="pop-wrap" ref={ref}>
      <button className="btn btn-sm tool-btn" onClick={() => (setDraft(f), setOpen(!open))}><FilterIcon />Filters{active ? ` (${active})` : ""}</button>
      {open && (
        <div className="pop">
          <div className="filter-grid">
            {field("minMcap", "Min MCAP ($)")}
            {field("maxMcap", "Max MCAP ($)")}
            {field("minLiquidity", "Min Liquidity ($)")}
            {field("minVolume", "Min Volume 24H ($)")}
            {field("minHolders", "Min Holders")}
            {field("maxAgeH", "Max Age (saat)")}
          </div>
          <div className="small muted">Tutarlarda 500k, 1.5m yazabilirsin.</div>
          <div className="pop-foot">
            <button className="btn" onClick={() => (setDraft(NOF), setF(NOF), setOpen(false))}>Clear</button>
            <button className="btn btn-primary" onClick={() => (setF(Object.fromEntries(Object.entries(draft).map(([k, v]) => [k, conv(v)])) as unknown as Filters), setOpen(false))}>Apply</button>
          </div>
        </div>
      )}
    </div>
  );
}
