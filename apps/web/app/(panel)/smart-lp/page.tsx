"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { Amount, compact, tone } from "@/components/Num";
import { CopyDialog } from "@/components/CopyDialog";
import { ago, short } from "@/lib/format";

interface Row {
  address: string;
  totalPnl: number;
  pnl7d: number;
  pnl30d: number;
  winRate: number | null;
  positions: number;
  openPools: number;
  fees: number;
  monthly: number | null;
  ev: number | null;
  avgInvested: number | null;
  openValue: number;
  lastActiveAt: string | null;
  daily: Array<{ day: string; pnl: number }>;
  copied: boolean;
}
interface Res { indexed: number; updatedAt: string | null; cap: number | null; netWorth: number; rows: Row[] }

interface F { active: "24h" | "7d" | "30d" | "any"; minWinRate: string; minPositions: string; minProfit: string; minMonthly: string; minEv: string; minFees: string; sizeToWallet: boolean }
const DEF: F = { active: "7d", minWinRate: "80", minPositions: "50", minProfit: "", minMonthly: "", minEv: "", minFees: "", sizeToWallet: true };
type Sort = "pnl_all" | "pnl_7d" | "pnl_30d" | "win_rate" | "positions" | "fees" | "monthly" | "ev" | "last_active" | "invested";

/** LP Agent "Smart LP": fee-checked wallets worth following, ranked, with Copy LP. */
export default function SmartLpPage() {
  const router = useRouter();
  const [f, setF] = useState<F>(DEF);
  const [draft, setDraft] = useState<F>(DEF);
  const [more, setMore] = useState(false);
  const [sort, setSort] = useState<{ k: Sort; dir: "asc" | "desc" }>({ k: "pnl_all", dir: "desc" });
  const [view, setView] = useState<"table" | "card">("table");
  const [d, setD] = useState<Res | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copy, setCopy] = useState<string | null>(null);

  useEffect(() => {
    try {
      const s = localStorage.getItem("binflip.smartLpFilters");
      if (s) {
        const v = { ...DEF, ...JSON.parse(s) } as F;
        setF(v);
        setDraft(v);
      }
    } catch {
      /* storage blocked */
    }
  }, []);

  const load = useCallback(() => {
    const qs = new URLSearchParams({ active: f.active, minWinRate: f.minWinRate || "0", minPositions: f.minPositions || "0", sizeToWallet: String(f.sizeToWallet), sort: sort.k, dir: sort.dir, limit: "100" });
    for (const k of ["minProfit", "minMonthly", "minEv", "minFees"] as const) if (f[k]) qs.set(k, f[k]);
    void api<Res>(`/v1/smart-lp?${qs}`).then((r) => (setD(r), setErr(null))).catch((e) => setErr((e as Error).message));
  }, [f, sort]);
  useEffect(load, [load]);

  const apply = (v: F) => {
    setF(v);
    try {
      localStorage.setItem("binflip.smartLpFilters", JSON.stringify(v));
    } catch {
      /* storage blocked */
    }
  };
  const th = (k: Sort, label: string) => (
    <th className={`num sortable ${sort.k === k ? "sorted" : ""}`} onClick={() => setSort((s) => ({ k, dir: s.k === k && s.dir === "desc" ? "asc" : "desc" }))}>
      {sort.k === k ? (sort.dir === "desc" ? "↓ " : "↑ ") : ""}
      {label}
    </th>
  );

  return (
    <main className="page page-wide">
      <div className="page-head">
        <h1>Smart LP</h1>
        <span className="muted small">LP fee'lerinden para kazanan cüzdanlar</span>
        <div className="spacer" />
        <div className="seg">
          <button className={view === "card" ? "on" : ""} onClick={() => setView("card")}>▦ Kart</button>
          <button className={view === "table" ? "on" : ""} onClick={() => setView("table")}>▤ Tablo</button>
        </div>
      </div>

      {d?.cap !== null && d && (
        <div className="banner banner-warn">
          Cüzdanına göre boyutlandı: toplam kârı en fazla {d.cap.toFixed(0)} SOL olan cüzdanlar (net varlığının 5 katı, en az 20 SOL). Daha büyük cüzdanları görmek için kapat.
          <div className="spacer" />
          <button className="btn btn-sm" onClick={() => (setDraft({ ...f, sizeToWallet: false }), apply({ ...f, sizeToWallet: false }))}>Sınırı kaldır</button>
        </div>
      )}

      <section className="card card-pad sl-filters">
        <label className="field small">Aktif
          <select value={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.value as F["active"] })}>
            <option value="24h">Son 24 saat</option>
            <option value="7d">Son 7 gün</option>
            <option value="30d">Son 30 gün</option>
            <option value="any">Her zaman</option>
          </select>
        </label>
        <label className="field small">Min kazanma oranı (%)<input type="number" value={draft.minWinRate} onChange={(e) => setDraft({ ...draft, minWinRate: e.target.value })} /></label>
        <label className="field small">Min pozisyon<input type="number" value={draft.minPositions} onChange={(e) => setDraft({ ...draft, minPositions: e.target.value })} /></label>
        {more && (
          <>
            <label className="field small">Min kâr (SOL)<input type="number" value={draft.minProfit} onChange={(e) => setDraft({ ...draft, minProfit: e.target.value })} /></label>
            <label className="field small">Min aylık kâr (SOL)<input type="number" value={draft.minMonthly} onChange={(e) => setDraft({ ...draft, minMonthly: e.target.value })} /></label>
            <label className="field small">Min EV (SOL)<input type="number" value={draft.minEv} onChange={(e) => setDraft({ ...draft, minEv: e.target.value })} /></label>
            <label className="field small">Min fee (SOL)<input type="number" value={draft.minFees} onChange={(e) => setDraft({ ...draft, minFees: e.target.value })} /></label>
          </>
        )}
        <label className="toggle-label small">Cüzdanıma göre boyutla <button className={`switch ${draft.sizeToWallet ? "on" : ""}`} onClick={() => setDraft({ ...draft, sizeToWallet: !draft.sizeToWallet })} aria-pressed={draft.sizeToWallet} /></label>
        <div className="sl-actions">
          <button className="btn btn-sm btn-ghost" onClick={() => setMore(!more)}>{more ? "Daha az filtre" : "Daha fazla filtre"}</button>
          <button className="btn btn-sm" onClick={() => (setDraft(DEF), apply(DEF))}>Temizle</button>
          <button className="btn btn-sm btn-primary" onClick={() => apply(draft)}>Filtrele</button>
        </div>
      </section>

      <div className="small muted" style={{ margin: "10px 0" }}>
        {d ? `${d.rows.length} cüzdan · indekste ${d.indexed} cüzdan · ${d.updatedAt ? `${ago(d.updatedAt)} güncellendi` : "indeks henüz oluşmadı (manager 30 dakikada bir yeniler)"}` : "Yükleniyor…"}
        {" · "}
        <span title="LP fee'leri kârının %10'undan azsa kâr token fiyatından gelmiştir (genelde kendi çıkardığı token); bu cüzdanlar listelenmez.">Sadece fee kontrolünden geçenler ⓘ</span>
        {" · "}kazanma oranı ve ortalamalar havuz bazındadır (Meteora verisi)
      </div>
      {err && <div className="banner banner-neg">{err}</div>}

      {view === "table" ? (
        <div className="card table-wrap">
          <table className="pf-table">
            <thead>
              <tr>
                <th>Cüzdan</th>
                {th("pnl_7d", "7G PnL")}
                {th("win_rate", "Kazanma")}
                {th("pnl_30d", "30G PnL")}
                {th("pnl_all", "Tüm zamanlar")}
                {th("positions", "Pozisyon")}
                {th("ev", "EV")}
                {th("invested", "Ort. yatırım")}
                {th("monthly", "Aylık")}
                {th("fees", "Fee")}
                {th("last_active", "Son aktif")}
                <th />
              </tr>
            </thead>
            <tbody>
              {d?.rows.map((r) => (
                <tr key={r.address} className="clickable" onClick={() => router.push(`/wallet/${r.address}`)}>
                  <td><span className="mono">{short(r.address, 5)}</span>{r.copied && <span className="src src-auto" style={{ marginLeft: 6 }}>kopyalanıyor</span>}</td>
                  <td className="num"><div className={tone(r.pnl7d)}><Amount sol={r.pnl7d} d={2} /></div><Spark daily={r.daily} /></td>
                  <td className={`num ${r.winRate === null ? "" : r.winRate >= 70 ? "pos" : r.winRate < 50 ? "neg" : ""}`}>{r.winRate === null ? "—" : `${r.winRate.toFixed(1)}%`}</td>
                  <td className={`num ${tone(r.pnl30d)}`}><Amount sol={r.pnl30d} d={2} /></td>
                  <td className={`num ${tone(r.totalPnl)}`}><Amount sol={r.totalPnl} d={2} /></td>
                  <td className="num">{compact(r.positions, 0)}<div className="small muted">{r.openPools} açık havuz</div></td>
                  <td className={`num ${tone(r.ev)}`}><Amount sol={r.ev} d={3} /></td>
                  <td className="num"><Amount sol={r.avgInvested} d={2} /></td>
                  <td className={`num ${tone(r.monthly)}`}><Amount sol={r.monthly} d={2} /></td>
                  <td className="num pos"><Amount sol={r.fees} d={2} /></td>
                  <td className="num muted">{ago(r.lastActiveAt)}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    {r.copied ? <Link className="btn btn-sm" href="/copy">Ayarlar</Link> : <button className="btn btn-sm btn-primary" onClick={() => setCopy(r.address)}>Copy LP</button>}
                  </td>
                </tr>
              ))}
              {d && !d.rows.length && <tr><td colSpan={12} className="empty">Filtrelere uyan cüzdan yok. Filtreleri gevşet ya da "Cüzdanıma göre boyutla"yı kapat.</td></tr>}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="pf-cards">
          {d?.rows.map((r) => (
            <div key={r.address} className="pf-card" onClick={() => router.push(`/wallet/${r.address}`)}>
              <div className="pf-card-top"><span className="mono">{short(r.address, 6)}</span>{!r.copied && <button className="btn btn-sm btn-primary" onClick={(e) => (e.stopPropagation(), setCopy(r.address))}>Copy LP</button>}</div>
              <Spark daily={r.daily} wide />
              <div className="pf-card-grid">
                <span className="muted">7G PnL</span><span className={tone(r.pnl7d)}><Amount sol={r.pnl7d} d={2} /></span>
                <span className="muted">Kazanma</span><span>{r.winRate === null ? "—" : `${r.winRate.toFixed(1)}%`}</span>
                <span className="muted">Tüm zamanlar</span><span className={tone(r.totalPnl)}><Amount sol={r.totalPnl} d={2} /></span>
                <span className="muted">Pozisyon</span><span>{compact(r.positions, 0)}</span>
                <span className="muted">Fee</span><span className="pos"><Amount sol={r.fees} d={2} /></span>
                <span className="muted">Son aktif</span><span>{ago(r.lastActiveAt)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
      <p className="small muted">İpucu: kopyalamadan önce cüzdanın pozisyonlarını ne kadar tuttuğuna bak. Her kopyalanan pozisyon bir swap, bir geri satış ve ağ ücreti demek; birkaç dakikada açıp kapatan bir cüzdan bu maliyeti tekrar tekrar ödetir.</p>
      {copy && <CopyDialog leader={null} initialAddress={copy} onClose={() => setCopy(null)} onSaved={() => (setCopy(null), load())} />}
    </main>
  );
}

/** Daily PnL bars for the last 7 days. */
function Spark({ daily, wide = false }: { daily: Array<{ day: string; pnl: number }>; wide?: boolean }) {
  const days = Array.from({ length: 7 }, (_, i) => new Date(Date.now() - (6 - i) * 86_400_000).toISOString().slice(0, 10));
  const v = days.map((d) => daily.find((x) => x.day === d)?.pnl ?? 0);
  const max = Math.max(1e-9, ...v.map(Math.abs));
  const W = wide ? 240 : 70, H = wide ? 30 : 16;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} aria-hidden style={{ display: "block", marginLeft: "auto" }}>
      {v.map((x, i) => {
        const h = (Math.abs(x) / max) * (H / 2 - 1);
        return <rect key={i} x={i * (W / 7) + 1} y={x >= 0 ? H / 2 - h : H / 2} width={W / 7 - 2} height={Math.max(0.5, h)} fill={x >= 0 ? "var(--pos)" : "var(--neg)"} />;
      })}
    </svg>
  );
}
