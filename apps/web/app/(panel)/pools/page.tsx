"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { compact } from "@/components/Num";
import { ago, short } from "@/lib/format";

export interface PoolRow {
  address: string;
  name: string;
  base: { mint: string; symbol: string; name: string; icon: string | null; holders: number; mcap: number; price: number; verified: boolean; decimals?: number };
  quote: { mint: string; symbol: string };
  binStep: number;
  baseFeePct: number;
  tvl: number;
  volume: number;
  fees: number;
  feeTvl: number;
  apr: number;
  price: number;
  createdAt: string | null;
  launchpad: string | null;
}

type Win = "30m" | "1h" | "2h" | "4h" | "12h" | "24h";
interface Filters {
  q: string;
  quote: "sol" | "usdc" | "sol_usdc" | "all";
  minTvl: string; maxTvl: string; minVolume: string; minVolume1h: string; minFees: string; minMcap: string; maxMcap: string;
  minHolders: string; minAgeH: string; maxAgeH: string; minBaseFee: string; maxBaseFee: string; binStep: string;
}
// New users start with a floor so the list is not flooded with dust pools (LP Agent default).
const DEFAULTS: Filters = { q: "", quote: "sol", minTvl: "5000", maxTvl: "", minVolume: "10000", minVolume1h: "", minFees: "", minMcap: "", maxMcap: "", minHolders: "", minAgeH: "", maxAgeH: "", minBaseFee: "", maxBaseFee: "", binStep: "" };

const money = (v: number) => `$${compact(v, 2)}`;
const ageOf = (iso: string | null) => {
  if (!iso) return "—";
  const h = (Date.now() - new Date(iso).getTime()) / 3_600_000;
  return h < 24 ? `${Math.max(1, Math.round(h))} sa` : h < 24 * 365 ? `${(h / 24).toFixed(0)} g` : `${(h / 24 / 365).toFixed(1)} y`;
};

/** LP Agent "Pools": every Meteora pool, sorted by Fee/TVL, with filters. */
export default function PoolsPage() {
  const router = useRouter();
  const [protocol, setProtocol] = useState<"dlmm" | "damm_v2">("dlmm");
  const [win, setWin] = useState<Win>("24h");
  const [sort, setSort] = useState<{ k: "fee_tvl" | "tvl" | "volume"; dir: "asc" | "desc" }>({ k: "fee_tvl", dir: "desc" });
  const [page, setPage] = useState(1);
  const [f, setF] = useState<Filters>(DEFAULTS);
  const [draft, setDraft] = useState<Filters>(DEFAULTS);
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<{ total: number; pages: number; rows: PoolRow[]; updatedAt: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const urlQ = new URLSearchParams(window.location.search).get("q");
    if (urlQ) {
      const v = { ...DEFAULTS, q: urlQ, minTvl: "", minVolume: "", quote: "all" as const };
      setF(v);
      setDraft(v);
      return;
    }
    try {
      const saved = localStorage.getItem("binflip.poolFilters");
      if (saved) {
        const v = { ...DEFAULTS, ...JSON.parse(saved) } as Filters;
        setF(v);
        setDraft(v);
      }
      const w = localStorage.getItem("binflip.poolWindow");
      if (w) setWin(w as Win);
    } catch {
      /* storage blocked */
    }
  }, []);

  const load = useCallback(() => {
    const qs = new URLSearchParams({ protocol, window: win, sort: sort.k, dir: sort.dir, page: String(page), pageSize: "20", quote: f.quote });
    for (const [k, v] of Object.entries(f)) if (k !== "quote" && v !== "") qs.set(k, v);
    void api<{ total: number; pages: number; rows: PoolRow[]; updatedAt: string }>(`/v1/pools?${qs}`)
      .then((d) => (setData(d), setErr(null)))
      .catch((e) => setErr((e as Error).message));
  }, [protocol, win, sort, page, f]);
  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  const apply = (v: Filters) => {
    setF(v);
    setPage(1);
    setOpen(false);
    try {
      localStorage.setItem("binflip.poolFilters", JSON.stringify(v));
    } catch {
      /* storage blocked */
    }
  };
  const active = Object.entries(f).filter(([k, v]) => k !== "quote" && v !== "").length;
  const th = (k: "fee_tvl" | "tvl" | "volume", label: React.ReactNode) => (
    <th className={`num sortable ${sort.k === k ? "sorted" : ""}`} onClick={() => setSort((s) => ({ k, dir: s.k === k && s.dir === "desc" ? "asc" : "desc" }))}>
      {sort.k === k ? (sort.dir === "desc" ? "↓ " : "↑ ") : ""}
      {label}
    </th>
  );

  return (
    <main className="page page-wide">
      <div className="page-head">
        <h1>Havuzlar</h1>
        <div className="seg">
          <button className={protocol === "dlmm" ? "on" : ""} onClick={() => (setProtocol("dlmm"), setPage(1))}>DLMM</button>
          <button className={protocol === "damm_v2" ? "on" : ""} onClick={() => (setProtocol("damm_v2"), setPage(1))}>DAMM V2</button>
        </div>
        <div className="spacer" />
        <label className="toggle-label">Pencere
          <select className="sel" value={win} onChange={(e) => { setWin(e.target.value as Win); try { localStorage.setItem("binflip.poolWindow", e.target.value); } catch { /* storage blocked */ } }}>
            {(["24h", "12h", "4h", "2h", "1h", "30m"] as const).map((w) => <option key={w} value={w}>{w}</option>)}
          </select>
        </label>
        <div className="pop-wrap">
          <button className="btn btn-sm" onClick={() => (setDraft(f), setOpen(!open))}>⛉ Filtreler{active ? ` (${active})` : ""}</button>
          {open && (
            <div className="pop pop-wide">
              <label className="field small">Havuz ya da token (ad veya adres)
                <input type="text" value={draft.q} onChange={(e) => setDraft({ ...draft, q: e.target.value })} placeholder="ör. BTC ya da mint adresi" />
              </label>
              <div className="field small">Karşı token
                <div className="seg full">
                  {(["sol", "usdc", "all"] as const).map((q) => <button key={q} className={draft.quote === q ? "on" : ""} onClick={() => setDraft({ ...draft, quote: q })}>{q === "sol" ? "SOL" : q === "usdc" ? "USDC" : "Hepsi"}</button>)}
                </div>
              </div>
              <div className="filter-grid">
                <Range label="Likidite ($)" a="minTvl" b="maxTvl" d={draft} set={setDraft} />
                <Range label="Piyasa değeri ($)" a="minMcap" b="maxMcap" d={draft} set={setDraft} />
                <Range label="Yaş (saat)" a="minAgeH" b="maxAgeH" d={draft} set={setDraft} />
                <Range label="Taban fee (%)" a="minBaseFee" b="maxBaseFee" d={draft} set={setDraft} />
                <One label={`Hacim ${win} en az ($)`} k="minVolume" d={draft} set={setDraft} />
                <One label="Hacim 1s en az ($)" k="minVolume1h" d={draft} set={setDraft} />
                <One label={`Fee ${win} en az ($)`} k="minFees" d={draft} set={setDraft} />
                <One label="Holder en az" k="minHolders" d={draft} set={setDraft} />
                {protocol === "dlmm" && <One label="Bin step" k="binStep" d={draft} set={setDraft} />}
              </div>
              <div className="small muted">Tutarlarda 500k, 1.5m, 2b yazabilirsin.</div>
              <div className="pop-foot">
                <button className="btn" onClick={() => (setDraft({ ...DEFAULTS, minTvl: "", minVolume: "" }), apply({ ...DEFAULTS, minTvl: "", minVolume: "" }))}>Hepsini temizle</button>
                <button className="btn btn-primary" onClick={() => apply(parseAmounts(draft))}>Uygula</button>
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="small muted" style={{ marginBottom: 10 }}>
        {data ? `${data.total.toLocaleString("tr-TR")} havuz eşleşiyor · ${ago(data.updatedAt)} güncellendi` : "Yükleniyor…"}
      </div>
      {err && <div className="banner banner-neg">{err}</div>}
      <div className="card table-wrap">
        <table className="pf-table">
          <thead>
            <tr>
              <th>Havuz</th>
              {th("fee_tvl", "Fee/TVL")}
              {th("tvl", "Likidite")}
              {th("volume", "Hacim")}
              <th className="num">Fee</th>
              <th className="num">MCAP</th>
              <th className="num">Holder</th>
              <th className="num">Yaş</th>
            </tr>
          </thead>
          <tbody>
            {data?.rows.filter((r) => !(f.minTvl && r.tvl < Number(f.minTvl))).map((r) => (
              <tr key={r.address} className="clickable" onClick={() => router.push(`/pools/${r.address}?protocol=${protocol}`)}>
                <td>
                  <div className="pair">
                    <div className="pair-icons">
                      <span className="pair-ph">{(r.base.symbol ?? "?").slice(0, 1)}</span>
                      {r.base.icon && <img src={r.base.icon} alt="" onError={(e) => (e.currentTarget.style.display = "none")} />}
                      <span className="pair-sol" aria-hidden>{r.quote.symbol === "SOL" ? "◎" : "$"}</span>
                    </div>
                    <div className="pair-text">
                      <div className="pair-top"><span className="pair-name">{r.base.symbol} / {r.quote.symbol}</span>{r.launchpad && <span className="src src-manual">{r.launchpad}</span>}</div>
                      <div className="pair-sub">
                        <span className="proto">{protocol === "dlmm" ? "DLMM" : "DAMM V2"}</span>
                        {protocol === "dlmm" && <span className="muted">bin {r.binStep}</span>}
                        <span className="muted">fee {r.baseFeePct}%</span>
                        <span className="mono muted">{short(r.address, 4)}</span>
                        <a className="muted" href={`https://app.meteora.ag/${protocol === "dlmm" ? "dlmm" : "dammv2"}/${r.address}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} title="Meteora">↗</a>
                      </div>
                    </div>
                  </div>
                </td>
                <td className="num pos">{r.feeTvl.toFixed(2)}%</td>
                <td className="num">{money(r.tvl)}</td>
                <td className="num">{money(r.volume)}</td>
                <td className="num">{money(r.fees)}</td>
                <td className="num">{r.base.mcap ? money(r.base.mcap) : "—"}</td>
                <td className="num">{r.base.holders ? compact(r.base.holders, 0) : "—"}</td>
                <td className="num muted">{ageOf(r.createdAt)}</td>
              </tr>
            ))}
            {data && !data.rows.length && <tr><td colSpan={8} className="empty">Filtrelere uyan havuz yok.</td></tr>}
          </tbody>
        </table>
      </div>
      {data && data.pages > 1 && (
        <div className="pager">
          <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>‹ Önceki</button>
          <span className="small muted">Sayfa {page} / {data.pages.toLocaleString("tr-TR")}</span>
          <button className="btn btn-sm" disabled={page >= data.pages} onClick={() => setPage(page + 1)}>Sonraki ›</button>
        </div>
      )}
      <p className="small muted">İpucu: küçük bir havuzda yüksek Fee/TVL hızla kaybolabilir. Pozisyon açmadan önce likiditeye, hacme ve yaşa birlikte bak. <Link className="link-accent" href="/portfolio">Portföy →</Link></p>
    </main>
  );
}

function parseAmounts(d: Filters): Filters {
  const conv = (v: string) => {
    const m = v.trim().toLowerCase().match(/^([\d.]+)\s*([kmb])?$/);
    if (!m) return v.trim();
    const n = Number(m[1]) * (m[2] === "k" ? 1e3 : m[2] === "m" ? 1e6 : m[2] === "b" ? 1e9 : 1);
    return Number.isFinite(n) ? String(n) : "";
  };
  const out = { ...d };
  for (const k of Object.keys(out) as Array<keyof Filters>) if (k !== "q" && k !== "quote") out[k] = conv(out[k]) as never;
  return out;
}

function Range({ label, a, b, d, set }: { label: string; a: keyof Filters; b: keyof Filters; d: Filters; set: (f: Filters) => void }) {
  return (
    <div className="field small">{label}
      <div className="minmax">
        <input type="text" placeholder="Min" value={d[a]} onChange={(e) => set({ ...d, [a]: e.target.value })} />
        <span>-</span>
        <input type="text" placeholder="Max" value={d[b]} onChange={(e) => set({ ...d, [b]: e.target.value })} />
      </div>
    </div>
  );
}
function One({ label, k, d, set }: { label: string; k: keyof Filters; d: Filters; set: (f: Filters) => void }) {
  return (
    <label className="field small">{label}
      <input type="text" value={d[k]} onChange={(e) => set({ ...d, [k]: e.target.value })} />
    </label>
  );
}
