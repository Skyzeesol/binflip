"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { compact } from "@/components/Num";
import { short } from "@/lib/format";
import { ageOfIso, ColumnsPicker, CopyBtn, FilterIcon, Leaf, TokenIcon, Updated, usd, useColumns } from "@/components/market";

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
  organicScore?: number | null;
  tokenLiquidity?: number | null;
  dynamicFeePct?: number | null;
}

type Col = "liq" | "vol" | "fees" | "mcap" | "holders" | "age" | "tliq" | "dynfee" | "apr";
const COLS: ReadonlyArray<{ id: Col; label: string; on: boolean }> = [
  { id: "liq", label: "Liquidity", on: true },
  { id: "vol", label: "Volume", on: true },
  { id: "fees", label: "Fees", on: true },
  { id: "mcap", label: "MCAP", on: true },
  { id: "holders", label: "Holders", on: true },
  { id: "age", label: "Age", on: true },
  { id: "tliq", label: "T LIQ", on: true },
  { id: "dynfee", label: "Dynamic fee", on: true },
  { id: "apr", label: "APR", on: false },
];

type Win = "30m" | "1h" | "2h" | "4h" | "12h" | "24h";
interface Filters {
  q: string;
  quote: "sol" | "usdc" | "sol_usdc" | "all";
  minTvl: string; maxTvl: string; minVolume: string; minVolume1h: string; minFees: string; minMcap: string; maxMcap: string;
  minHolders: string; minAgeH: string; maxAgeH: string; minBaseFee: string; maxBaseFee: string; binStep: string;
}
// New users start with a floor so the list is not flooded with dust pools (LP Agent default).
const DEFAULTS: Filters = { q: "", quote: "sol", minTvl: "5000", maxTvl: "", minVolume: "10000", minVolume1h: "", minFees: "", minMcap: "", maxMcap: "", minHolders: "", minAgeH: "", maxAgeH: "", minBaseFee: "", maxBaseFee: "", binStep: "" };


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
  const cols = useColumns<Col>("binflip.poolCols", COLS);

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
  const setWindow = (w: Win) => {
    setWin(w);
    try {
      localStorage.setItem("binflip.poolWindow", w);
    } catch {
      /* storage blocked */
    }
  };
  const W = win.toUpperCase();
  const nCols = 2 + cols.shown.size;

  return (
    <main className="page page-full" lang="en">
      <div className="mk-bar">
        <div className="mk-tabs">
          <button className={protocol === "dlmm" ? "on" : ""} onClick={() => (setProtocol("dlmm"), setPage(1))}>DLMM</button>
          <button className={protocol === "damm_v2" ? "on" : ""} onClick={() => (setProtocol("damm_v2"), setPage(1))}>DAMM V2</button>
        </div>
        <div className="spacer" />
        <div className="pop-wrap">
          <button className="btn btn-sm tool-btn" onClick={() => (setDraft(f), setOpen(!open))}><FilterIcon />Filters{active ? ` (${active})` : ""}</button>
          {open && (
            <div className="pop pop-wide">
              <label className="field small">Pool ya da token (ad veya adres)
                <input type="text" value={draft.q} onChange={(e) => setDraft({ ...draft, q: e.target.value })} placeholder="ör. BTC ya da mint adresi" />
              </label>
              <div className="field small">Quote token
                <div className="seg full">
                  {(["sol", "usdc", "all"] as const).map((q) => <button key={q} className={draft.quote === q ? "on" : ""} onClick={() => setDraft({ ...draft, quote: q })}>{q === "sol" ? "SOL" : q === "usdc" ? "USDC" : "All"}</button>)}
                </div>
              </div>
              <div className="filter-grid">
                <Range label="Liquidity ($)" a="minTvl" b="maxTvl" d={draft} set={setDraft} />
                <Range label="MCAP ($)" a="minMcap" b="maxMcap" d={draft} set={setDraft} />
                <Range label="Age (saat)" a="minAgeH" b="maxAgeH" d={draft} set={setDraft} />
                <Range label="Base fee (%)" a="minBaseFee" b="maxBaseFee" d={draft} set={setDraft} />
                <One label={`Min Volume ${W} ($)`} k="minVolume" d={draft} set={setDraft} />
                <One label="Min Volume 1H ($)" k="minVolume1h" d={draft} set={setDraft} />
                <One label={`Min Fees ${W} ($)`} k="minFees" d={draft} set={setDraft} />
                <One label="Min Holders" k="minHolders" d={draft} set={setDraft} />
                {protocol === "dlmm" && <One label="Bin step" k="binStep" d={draft} set={setDraft} />}
              </div>
              <div className="small muted">Tutarlarda 500k, 1.5m, 2b yazabilirsin.</div>
              <div className="pop-foot">
                <button className="btn" onClick={() => (setDraft({ ...DEFAULTS, minTvl: "", minVolume: "" }), apply({ ...DEFAULTS, minTvl: "", minVolume: "" }))}>Clear</button>
                <button className="btn btn-primary" onClick={() => apply(parseAmounts(draft))}>Apply</button>
              </div>
            </div>
          )}
        </div>
        <ColumnsPicker all={COLS} shown={cols.shown} toggle={cols.toggle} />
      </div>
      {err && <div className="banner banner-neg">{err}</div>}
      <div className="card mk-card">
        <div className="mk-head">
          <div><b>{data ? data.total.toLocaleString("en-US") : "—"} pools</b> <span className="muted">on Solana</span></div>
          <div className="spacer" />
          <Updated at={data?.updatedAt} />
        </div>
        <div className="table-wrap">
          <table className="mk-table">
            <thead>
              <tr>
                <th>Pool</th>
                <th className={`num sortable ${sort.k === "fee_tvl" ? "sorted" : ""}`}>
                  <span onClick={() => setSort((s) => ({ k: "fee_tvl", dir: s.k === "fee_tvl" && s.dir === "desc" ? "asc" : "desc" }))}>{sort.k === "fee_tvl" ? (sort.dir === "desc" ? "↓ " : "↑ ") : ""}Fee/TVL</span>{" "}
                  <select className="th-sel" value={win} onChange={(e) => setWindow(e.target.value as Win)}>
                    {(["30m", "1h", "2h", "4h", "12h", "24h"] as const).map((w) => <option key={w} value={w}>{w.toUpperCase()}</option>)}
                  </select>
                </th>
                {cols.has("liq") && th("tvl", "Liquidity")}
                {cols.has("vol") && th("volume", `Volume ${W}`)}
                {cols.has("fees") && <th className="num">Fees {W}</th>}
                {cols.has("mcap") && <th className="num">MCAP</th>}
                {cols.has("holders") && <th className="num">Holders</th>}
                {cols.has("age") && <th className="num">Age</th>}
                {cols.has("tliq") && <th className="num" title="Tokenin bütün DEX'lerdeki toplam likiditesi (Jupiter)">T LIQ</th>}
                {cols.has("dynfee") && <th className="num" title="Şu anki toplam swap fee'si (taban + volatiliteye bağlı dinamik kısım)">Dynamic fee</th>}
                {cols.has("apr") && <th className="num">APR</th>}
              </tr>
            </thead>
            <tbody>
              {data?.rows.filter((r) => !(f.minTvl && r.tvl < Number(f.minTvl))).map((r) => (
                <tr key={r.address} className="clickable" onClick={() => router.push(`/pools/${r.address}?protocol=${protocol}`)}>
                  <td>
                    <div className="tok">
                      <span className="pair-ico">
                        <TokenIcon icon={r.base.icon} symbol={r.base.symbol} size={30} />
                        <span className="quote-ico" aria-hidden>{r.quote.symbol === "SOL" ? "◎" : "$"}</span>
                      </span>
                      <div className="tok-text">
                        <div className="tok-top"><b>{r.base.symbol} / {r.quote.symbol}</b><span className="fee-badge" title="Base fee">{r.baseFeePct.toFixed(2)}%</span><Leaf score={r.organicScore} /></div>
                        <div className="tok-sub">
                          <span className={`proto ${protocol === "dlmm" ? "" : "proto-damm"}`}>{protocol === "dlmm" ? "DLMM" : "DAMM V2"}</span>
                          {protocol === "dlmm" && <span className="muted">bin {r.binStep}</span>}
                          <span className="mono muted">{short(r.address, 6)}</span>{r.launchpad && <span className="lp-tag">{r.launchpad}</span>}
                          <CopyBtn text={r.address} />
                          <a className="muted" href={`https://app.meteora.ag/${protocol === "dlmm" ? "dlmm" : "dammv2"}/${r.address}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} title="Meteora">↗</a>
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="num"><span className="pos strong">{r.feeTvl.toFixed(2)}%</span></td>
                  {cols.has("liq") && <td className="num">{usd(r.tvl)}</td>}
                  {cols.has("vol") && <td className="num">{usd(r.volume)}</td>}
                  {cols.has("fees") && <td className="num">{usd(r.fees)}</td>}
                  {cols.has("mcap") && <td className="num">{r.base.mcap ? usd(r.base.mcap) : "—"}</td>}
                  {cols.has("holders") && <td className="num">{r.base.holders ? (r.base.holders >= 1000 ? compact(r.base.holders, 1) : r.base.holders) : "—"}</td>}
                  {cols.has("age") && <td className="num">{ageOfIso(r.createdAt)}</td>}
                  {cols.has("tliq") && <td className="num">{usd(r.tokenLiquidity)}</td>}
                  {cols.has("dynfee") && <td className="num">{r.dynamicFeePct === null || r.dynamicFeePct === undefined ? "—" : `${r.dynamicFeePct.toFixed(2)}%`}</td>}
                  {cols.has("apr") && <td className="num">{r.apr ? `${compact(r.apr, 1)}%` : "—"}</td>}
                </tr>
              ))}
              {data && !data.rows.length && <tr><td colSpan={nCols} className="empty">Filtrelere uyan pool yok.</td></tr>}
              {!data && !err && <tr><td colSpan={nCols} className="empty">Yükleniyor…</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      {data && data.pages > 1 && (
        <div className="pager">
          <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>‹ Prev</button>
          <span className="small muted">Page {page} / {data.pages.toLocaleString("en-US")}</span>
          <button className="btn btn-sm" disabled={page >= data.pages} onClick={() => setPage(page + 1)}>Next ›</button>
        </div>
      )}
      <p className="small muted">İpucu: küçük bir havuzda yüksek Fee/TVL hızla kaybolabilir. Pozisyon açmadan önce likiditeye, hacme ve yaşa birlikte bak. <Link className="link-accent" href="/portfolio">Portfolio →</Link></p>
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
