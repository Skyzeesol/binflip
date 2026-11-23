"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { compact } from "@/components/Num";
import { ago, short } from "@/lib/format";

type Preset = "trending" | "new" | "fee_tvl" | "smart" | "nopool";
type Win = "30m" | "1h" | "4h" | "24h";
interface PoolLite { address: string; name: string; binStep: number; baseFee: number; tvl: number; volume24h: number; fees24h: number; feeTvl: Record<Win, number> }
interface Token {
  mint: string; symbol: string; name: string; icon: string | null; launchpad: string | null; verified: boolean;
  ageH: number | null; price: number; priceChange24h: number; mcap: number; holders: number; volume24h: number;
  volumeChange1h: number; volumeChange24h: number; organicScore: number | null; top10Pct: number | null; devPct: number | null;
  mintRevoked: boolean; freezeRevoked: boolean; safety: number | null; safetyLabel: "safe" | "caution" | "risky" | null;
  smartLps: number; pools: number; liquidity: number; bestPool: { address: string; feeTvl: Record<Win, number>; binStep: number; tvl: number } | null; poolList: PoolLite[];
}
interface Res { preset: Preset; floor: string | null; updatedAt: string; rows: Token[] }

const PRESETS: Array<{ id: Preset; label: string; hint: string }> = [
  { id: "trending", label: "Trend", hint: "Bu saatin hacmi bir önceki saate göre en çok artanlar (hacim tabanının üstündekiler)." },
  { id: "new", label: "Yeni", hint: "En yeni tokenler önce." },
  { id: "fee_tvl", label: "En iyi Fee/TVL", hint: "Havuzları likiditesine göre en çok fee kazandıran tokenler (son 1 saat)." },
  { id: "smart", label: "Smart money", hint: "Havuzlarında en çok Smart LP pozisyonu olan tokenler." },
  { id: "nopool", label: "Havuzu yok", hint: "Hacmi olan ama listelenecek Meteora havuzu henüz olmayan tokenler." },
];
const money = (v: number) => `$${compact(v, 2)}`;
const SAFETY_TR = { safe: "Güvenli", caution: "Dikkat", risky: "Riskli" } as const;
const age = (h: number | null) => (h === null ? "—" : h < 1 / 60 ? `${Math.round(h * 3600)} sn` : h < 1 ? `${Math.round(h * 60)} dk` : h < 48 ? `${h.toFixed(0)} sa` : `${(h / 24).toFixed(0)} g`);

/** LP Agent "Discover": pick the token first (volume, Fee/TVL, safety, smart LPs), then its best pool. */
export default function DiscoverPage() {
  const [preset, setPreset] = useState<Preset>("trending");
  const [hideRisky, setHideRisky] = useState(true);
  const [win, setWin] = useState<Win>("1h");
  const [q, setQ] = useState("");
  const [d, setD] = useState<Res | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [sort, setSort] = useState<{ k: string; dir: 1 | -1 } | null>(null);

  useEffect(() => {
    try {
      const s = JSON.parse(localStorage.getItem("binflip.discover") ?? "{}") as { preset?: Preset; hideRisky?: boolean };
      if (s.preset) setPreset(s.preset);
      if (s.hideRisky !== undefined) setHideRisky(s.hideRisky);
    } catch {
      /* storage blocked */
    }
  }, []);
  const load = useCallback(() => {
    const qs = new URLSearchParams({ preset, hideRisky: String(hideRisky) });
    if (q.trim()) qs.set("q", q.trim());
    void api<Res>(`/v1/discover?${qs}`).then((r) => (setD(r), setErr(null))).catch((e) => setErr((e as Error).message));
    try {
      localStorage.setItem("binflip.discover", JSON.stringify({ preset, hideRisky }));
    } catch {
      /* storage blocked */
    }
  }, [preset, hideRisky, q]);
  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  const val = (t: Token, k: string): number =>
    k === "age" ? -(t.ageH ?? 1e9) : k === "mcap" ? t.mcap : k === "holders" ? t.holders : k === "vol" ? t.volume24h : k === "volchg" ? t.volumeChange1h : k === "liq" ? t.liquidity : k === "feetvl" ? (t.bestPool?.feeTvl[win] ?? 0) : k === "safety" ? (t.safety ?? -1) : k === "smart" ? t.smartLps : 0;
  const rows = sort && d ? [...d.rows].sort((a, b) => (val(a, sort.k) - val(b, sort.k)) * sort.dir) : (d?.rows ?? []);
  const th = (k: string, label: string) => (
    <th className={`num sortable ${sort?.k === k ? "sorted" : ""}`} onClick={() => setSort((s) => ({ k, dir: s?.k === k && s.dir === -1 ? 1 : -1 }))}>
      {sort?.k === k ? (sort.dir === -1 ? "↓ " : "↑ ") : ""}
      {label}
    </th>
  );

  return (
    <main className="page page-wide">
      <div className="page-head">
        <h1>Discover</h1>
        <span className="muted small">Önce doğru tokeni seç: güvenli token, sağlıklı hacim, iyi Fee/TVL.</span>
      </div>
      <div className="disc-bar">
        <div className="seg">
          {PRESETS.map((p) => <button key={p.id} className={preset === p.id ? "on" : ""} title={p.hint} onClick={() => (setPreset(p.id), setSort(null))}>{p.label}</button>)}
        </div>
        <label className="toggle-label">Riskli olanları gizle <button className={`switch ${hideRisky ? "on" : ""}`} onClick={() => setHideRisky(!hideRisky)} aria-pressed={hideRisky} /></label>
        <label className="toggle-label">Fee/TVL
          <select className="sel" value={win} onChange={(e) => setWin(e.target.value as Win)}>
            {(["30m", "1h", "4h", "24h"] as const).map((w) => <option key={w} value={w}>{w}</option>)}
          </select>
        </label>
        <div className="spacer" />
        <form onSubmit={(e) => (e.preventDefault(), load())}>
          <input className="disc-search" type="text" placeholder="Token adı ya da adresi" value={q} onChange={(e) => setQ(e.target.value)} />
        </form>
      </div>
      <div className="small muted" style={{ margin: "8px 0" }}>
        {PRESETS.find((p) => p.id === preset)?.hint} {d?.floor ? `Taban: ${d.floor}.` : ""} {d ? `${ago(d.updatedAt)} güncellendi.` : "Yükleniyor…"}
      </div>
      {err && <div className="banner banner-neg">{err}</div>}
      <div className="card table-wrap">
        <table className="pf-table">
          <thead>
            <tr>
              <th>Token</th>
              {th("age", "Yaş")}
              <th className="num">Fiyat 24s</th>
              {th("mcap", "MCap")}
              {th("holders", "Holder")}
              {th("vol", "Hacim 24s")}
              {th("volchg", "Hacim değ. 1s")}
              {th("liq", "Likidite")}
              {th("feetvl", `Fee/TVL ${win}`)}
              {th("safety", "Güvenlik")}
              {th("smart", "Smart LP")}
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <Fragment key={t.mint}>
                <tr className="clickable" onClick={() => setOpen(open === t.mint ? null : t.mint)}>
                  <td>
                    <div className="pair">
                      <div className="pair-icons" style={{ width: 30 }}>
                        <span className="pair-ph">{t.symbol?.slice(0, 1)}</span>
                        {t.icon && <img src={t.icon} alt="" onError={(e) => (e.currentTarget.style.display = "none")} />}
                      </div>
                      <div className="pair-text">
                        <div className="pair-top"><b>{t.symbol}</b>{t.verified && <span className="pos small">✓</span>}{t.launchpad && <span className="src src-manual">{t.launchpad}</span>}</div>
                        <div className="pair-sub"><span className="muted">{t.name?.slice(0, 18)}</span><span className="muted">{t.pools ? `${t.pools >= 10 ? "10+" : t.pools} havuz` : "Havuz yok"}</span></div>
                      </div>
                    </div>
                  </td>
                  <td className="num">{age(t.ageH)}</td>
                  <td className="num">${t.price < 0.01 ? t.price.toPrecision(3) : t.price.toFixed(4)}<div className={`small ${t.priceChange24h >= 0 ? "pos" : "neg"}`}>{t.priceChange24h >= 0 ? "+" : ""}{t.priceChange24h.toFixed(1)}%</div></td>
                  <td className="num">{money(t.mcap)}</td>
                  <td className="num">{compact(t.holders, 0)}</td>
                  <td className="num">{money(t.volume24h)}</td>
                  <td className={`num ${t.volumeChange1h >= 0 ? "pos" : "neg"}`}>{t.volumeChange1h >= 0 ? "+" : ""}{compact(t.volumeChange1h, 0)}%</td>
                  <td className="num">{t.liquidity ? money(t.liquidity) : "—"}</td>
                  <td className="num pos">{t.bestPool ? `${t.bestPool.feeTvl[win].toFixed(2)}%` : "—"}</td>
                  <td className="num">
                    {t.safety === null ? <span className="muted">—</span> : (
                      <span className={`safety safety-${t.safetyLabel}`} title={`Mint yetkisi: ${t.mintRevoked ? "kaldırılmış" : "VAR"} · Freeze yetkisi: ${t.freezeRevoked ? "kaldırılmış" : "VAR"} · İlk 10 holder: ${t.top10Pct?.toFixed(1) ?? "—"}% · Organic: ${t.organicScore?.toFixed(0) ?? "—"} · Holder: ${t.holders}`}>
                        {t.safety} {SAFETY_TR[t.safetyLabel!]}
                      </span>
                    )}
                  </td>
                  <td className="num">{t.smartLps || "—"}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    {t.bestPool ? <Link className="btn btn-sm btn-primary" href={`/pools/${t.bestPool.address}?protocol=dlmm`}>Havuzu aç</Link> : <a className="btn btn-sm" href={`https://app.meteora.ag/dlmm/create-pool?baseMint=${t.mint}`} target="_blank" rel="noreferrer">Havuz kur ↗</a>}
                  </td>
                </tr>
                {open === t.mint && (
                  <tr className="disc-pools">
                    <td colSpan={12}>
                      {t.poolList.length ? (
                        <table>
                          <thead><tr><th>Havuz</th><th className="num">Likidite</th><th className="num">Hacim 24s</th><th className="num">Fee 24s</th><th className="num">Fee/TVL 30m</th><th className="num">1s</th><th className="num">4s</th><th className="num">24s</th><th /></tr></thead>
                          <tbody>
                            {[...t.poolList].sort((a, b) => b.feeTvl["1h"] - a.feeTvl["1h"]).map((p, i) => (
                              <tr key={p.address}>
                                <td>{p.name} <span className="muted small">bin {p.binStep} · fee {p.baseFee}% · {short(p.address, 4)}</span>{i === 0 && <span className="src src-auto" style={{ marginLeft: 6 }}>En iyi fee/TVL</span>}</td>
                                <td className="num">{money(p.tvl)}</td>
                                <td className="num">{money(p.volume24h)}</td>
                                <td className="num">{money(p.fees24h)}</td>
                                {(["30m", "1h", "4h", "24h"] as const).map((w) => <td key={w} className="num pos">{p.feeTvl[w].toFixed(2)}%</td>)}
                                <td><Link className="btn btn-sm" href={`/pools/${p.address}?protocol=dlmm`}>Aç</Link></td>
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
            {d && !rows.length && <tr><td colSpan={12} className="empty">Bu listede token yok.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="small muted">İpucu: Fee/TVL'si çok yüksek ama "Riskli" görünen bir token genelde yüksekliğin sebebidir. Güvenlik puanı Binflip'in kendi hesabıdır (mint/freeze yetkisi, ilk 10 holder, organic score, holder sayısı).</p>
    </main>
  );
}
