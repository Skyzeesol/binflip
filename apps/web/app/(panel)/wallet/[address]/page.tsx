"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { Amount, Pct, tone } from "@/components/Num";
import { CopyDialog } from "@/components/CopyDialog";
import { FeeHistory, type Group, type Metric, type Proto, type Range } from "@/components/portfolio/FeeHistory";
import { closedAt } from "@/components/portfolio/Positions";
import { short } from "@/lib/format";
import type { PfBucket } from "@/lib/types";

interface PoolRow {
  pool: string;
  pair: string;
  tokenX: string;
  iconX: string | null;
  mintX: string;
  binStep: number;
  baseFee: number;
  depositSol: number;
  pnlSol: number;
  pnlPct: number;
}
interface ClosedRow extends PoolRow { withdrawSol: number; feeSol: number; lastClosedAt: string | null }
interface OpenRow extends PoolRow { valueSol: number; unclaimedSol: number; positions: string[]; outOfRange: boolean; feePerTvl24h: number }
interface WalletData {
  address: string;
  copy: { id: string; label: string; status: string } | null;
  summary: {
    netWorth: number; solBalance: number | null; openValue: number; openUnclaimed: number; openPnl: number;
    totalClosed: number; totalProfit: number; totalProfitPct: number; winRate: number | null; avgInvested: number | null;
    feeEarned: number; avgMonthlyProfit: number | null; expectedValue: number | null; sampledPools: number;
  };
  open: OpenRow[];
  closed: ClosedRow[];
  days: PfBucket[];
  feeDays: PfBucket[];
}

/** LP Agent: any wallet's portfolio, read-only, with "Copy LP" next to the address. */
export default function WalletPage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = use(params);
  const [d, setD] = useState<WalletData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pages, setPages] = useState(3);
  const [copying, setCopying] = useState(false);
  const [metric, setMetric] = useState<Metric>("pnl");
  const [group, setGroup] = useState<Group>("day");
  const [range, setRange] = useState<Range>("ALL");
  const [proto, setProto] = useState<Proto>("all");

  const load = useCallback(() => {
    setErr(null);
    void api<WalletData>(`/v1/wallets/${address}?pages=${pages}`).then(setD).catch((e) => setErr((e as Error).message));
  }, [address, pages]);
  useEffect(load, [load]);

  const s = d?.summary;
  return (
    <main className="page page-wide">
      <div className="pf-head">
        <div className="pf-addr">
          <span className="mono">{address}</span>
          <button className="btn btn-sm btn-ghost" onClick={() => navigator.clipboard.writeText(address)} aria-label="Adresi kopyala">⧉</button>
          <span className="badge">◎ Solana</span>
          {d?.copy ? (
            <Link className="badge badge-pos" href={`/copy?edit=${d.copy.id}`} title="Kopya ayarlarını düzenle">Kopyalanıyor: {d.copy.label} ({d.copy.status === "active" ? "aktif" : "duraklatıldı"})</Link>
          ) : (
            <button className="btn btn-sm btn-primary" onClick={() => setCopying(true)}>Copy LP</button>
          )}
        </div>
        <div className="pf-sub muted small">
          Görüntüle: <a href={`https://solscan.io/account/${address}`} target="_blank" rel="noreferrer">Solscan</a> · <a href={`https://jup.ag/portfolio/${address}`} target="_blank" rel="noreferrer">Jupiter</a> ·
          <button className="btn btn-sm btn-ghost" onClick={load} aria-label="Yenile">⟳</button>
        </div>
      </div>
      <div className="note" style={{ marginBottom: 14 }}>
        Başka bir cüzdanın PnL'i, ölçüm sınırları yüzünden gerçekte kazandığından farklı olabilir. Veri Meteora'nın açık API'sinden gelir; kapanan pozisyonlar havuz bazında toplanmıştır (kazanma oranı ve ortalamalar havuz başınadır, son {s?.sampledPools ?? "—"} havuz).
      </div>
      {err && <div className="banner banner-neg">{err}</div>}

      <section className="card pf-top">
        <div className="pf-metrics">
          <div className="pf-networth">
            <div className="kpi-label">TOPLAM NET VARLIK</div>
            <div className="kpi-big"><Amount sol={s?.netWorth ?? null} d={2} /></div>
            <div className="small muted">cüzdanda <Amount sol={s?.solBalance ?? null} d={2} /> · pozisyonlarda <Amount sol={s?.openValue ?? null} d={2} /></div>
          </div>
          <K label="KAPANAN" v={s ? s.totalClosed.toLocaleString("tr-TR") : "—"} />
          <K label="KAZANMA ORANI" v={s?.winRate == null ? "—" : `${s.winRate.toFixed(2)}%`} cls={s?.winRate == null ? "" : s.winRate >= 70 ? "pos" : s.winRate < 50 ? "neg" : ""} />
          <K label="ORT. YATIRIM (havuz)" v={<Amount sol={s?.avgInvested ?? null} d={2} />} />
          <K label="KAZANILAN FEE" v={<Amount sol={s?.feeEarned ?? null} d={2} />} cls="pos" />
          <K label="TOPLAM KÂR (tüm zamanlar)" v={<Amount sol={s?.totalProfit ?? null} d={2} />} cls={tone(s?.totalProfit)} />
          <K label="ORT. AYLIK KÂR" v={<Amount sol={s?.avgMonthlyProfit ?? null} d={2} />} cls={tone(s?.avgMonthlyProfit)} />
          <K label="BEKLENEN DEĞER (EV)" v={<Amount sol={s?.expectedValue ?? null} d={2} />} cls={tone(s?.expectedValue)} />
        </div>
        <div className="pf-chart">
          <div className="kpi-label">{metric === "pnl" ? "KÂR GEÇMİŞİ" : "FEE GEÇMİŞİ"}</div>
          {d && (
            <FeeHistory
              metric={metric} setMetric={setMetric} group={group} setGroup={setGroup} range={range} setRange={setRange} proto={proto} setProto={setProto}
              series={metric === "pnl" ? d.days : d.feeDays} days={d.days} feeDays={d.feeDays}
            />
          )}
        </div>
      </section>

      <section className="card pf-section">
        <div className="pf-section-head">
          <div>
            <h2>Açık pozisyonlar ({d?.open.reduce((n, o) => n + o.positions.length, 0) ?? 0})</h2>
            <div className="pf-totals">
              <span>Toplam değer <b><Amount sol={s?.openValue ?? null} d={2} /></b></span>
              <span>Toplam uPnL <b className={tone(s?.openPnl)}><Amount sol={s?.openPnl ?? null} d={2} /></b></span>
              <span>Bekleyen fee <b className="pos"><Amount sol={s?.openUnclaimed ?? null} d={2} /></b></span>
            </div>
          </div>
        </div>
        <div className="table-wrap">
          <table className="pf-table">
            <thead><tr><th>Havuz</th><th className="num">Pozisyon</th><th className="num">Yatırılan</th><th className="num">Değer</th><th className="num">Bekleyen fee</th><th className="num">uPnL</th><th className="num">Fee/TVL 24s</th><th>Aralık</th></tr></thead>
            <tbody>
              {d?.open.map((o) => (
                <tr key={o.pool}>
                  <td><Pair r={o} /></td>
                  <td className="num">{o.positions.length}</td>
                  <td className="num"><Amount sol={o.depositSol} /></td>
                  <td className="num"><Amount sol={o.valueSol} /></td>
                  <td className="num pos"><Amount sol={o.unclaimedSol} /></td>
                  <td className="num"><div className={tone(o.pnlSol)}><Amount sol={o.pnlSol} /></div><div className={`small ${tone(o.pnlSol)}`}><Pct v={o.pnlPct} /></div></td>
                  <td className="num"><Pct v={o.feePerTvl24h} /></td>
                  <td>{o.outOfRange ? <span className="badge badge-neg">Aralık dışı</span> : <span className="badge badge-pos">Aralıkta</span>}</td>
                </tr>
              ))}
              {d && !d.open.length && <tr><td colSpan={8} className="empty">Açık pozisyon yok.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card pf-section">
        <div className="pf-section-head">
          <h2>Geçmiş pozisyonlar <span className="muted small">(havuz bazında, en yeni önce)</span></h2>
        </div>
        <div className="table-wrap">
          <table className="pf-table">
            <thead><tr><th>Havuz</th><th className="num">Yatırılan</th><th className="num">Çekilen</th><th className="num">Toplam fee</th><th className="num">PnL</th><th className="num">Son kapanış</th></tr></thead>
            <tbody>
              {d?.closed.map((c) => (
                <tr key={c.pool}>
                  <td><Pair r={c} /></td>
                  <td className="num"><Amount sol={c.depositSol} /></td>
                  <td className="num"><Amount sol={c.withdrawSol} /></td>
                  <td className="num pos"><Amount sol={c.feeSol} /></td>
                  <td className="num"><div className={tone(c.pnlSol)}><Amount sol={c.pnlSol} /></div><div className={`small ${tone(c.pnlSol)}`}><Pct v={c.pnlPct} /></div></td>
                  <td className="num muted">{closedAt(c.lastClosedAt)}</td>
                </tr>
              ))}
              {d && !d.closed.length && <tr><td colSpan={6} className="empty">Kapanmış pozisyon yok.</td></tr>}
            </tbody>
          </table>
        </div>
        {d && d.closed.length >= pages * 20 && pages < 10 && (
          <div className="card-pad"><button className="btn btn-sm" onClick={() => setPages(pages + 3)}>Daha fazla yükle</button></div>
        )}
      </section>

      {copying && <CopyDialog leader={null} initialAddress={address} onClose={() => setCopying(false)} onSaved={() => (setCopying(false), load())} />}
    </main>
  );
}

function K({ label, v, cls = "" }: { label: string; v: React.ReactNode; cls?: string }) {
  return (
    <div>
      <div className="kpi-label">{label}</div>
      <div className={`kpi-value ${cls}`}>{v}</div>
    </div>
  );
}

function Pair({ r }: { r: PoolRow }) {
  return (
    <div className="pair">
      <div className="pair-icons">
        <span className="pair-ph">{r.tokenX.slice(0, 1)}</span>
        {r.iconX && <img src={r.iconX} alt="" onError={(e) => (e.currentTarget.style.display = "none")} />}
        <span className="pair-sol" aria-hidden>◎</span>
      </div>
      <div className="pair-text">
        <Link className="pair-name" href={`/pools/${r.pool}`}>{r.pair.replace("/", " / ")}</Link>
        <div className="pair-sub"><span className="proto">DLMM</span><span className="muted">bin {r.binStep} · fee {r.baseFee}%</span><span className="mono muted">{short(r.pool, 4)}</span></div>
      </div>
    </div>
  );
}
