"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { Account, PfPosition, Portfolio } from "@/lib/types";
import { Amount, NetWorth, tone } from "@/components/Num";
import { FeeHistory, type Group, type Metric, type Proto, type Range } from "@/components/portfolio/FeeHistory";
import { EMPTY_FILTER, HistoricalPositions, OpenPositions, type HistFilter, type RowActions } from "@/components/portfolio/Positions";
import { ActionDialog, ExitsDialog, PositionDrawer, type ActionKind } from "@/components/portfolio/Dialogs";
import { ago } from "@/lib/format";
import { ShareCard } from "@/components/portfolio/ShareCard";
import { chime, soundsOn } from "@/lib/sound";
import { useRef } from "react";

export default function PortfolioPage() {
  const [acc, setAcc] = useState<Account | null>(null);
  const [pf, setPf] = useState<Portfolio | null>(null);
  const [open, setOpen] = useState<PfPosition[]>([]);
  const [closed, setClosed] = useState<{ positions: PfPosition[]; pools: Array<{ pool: string; token: string | null }> }>({ positions: [], pools: [] });
  const [metric, setMetric] = useState<Metric>("pnl");
  const [group, setGroup] = useState<Group>("day");
  const [range, setRange] = useState<Range>("ALL");
  const [proto, setProto] = useState<Proto>("all");
  const [filter, setFilter] = useState<HistFilter>(EMPTY_FILTER);
  const [updated, setUpdated] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [action, setAction] = useState<{ p: PfPosition; kind: ActionKind } | null>(null);
  const [exits, setExits] = useState<PfPosition | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [share, setShare] = useState<PfPosition | null>(null);
  const openIds = useRef<Set<string> | null>(null);

  const load = useCallback(async () => {
    const qs = new URLSearchParams({ status: "closed" });
    if (filter.protocol !== "all") qs.set("protocol", filter.protocol);
    if (filter.source !== "all") qs.set("source", filter.source);
    if (filter.pool) qs.set("pool", filter.pool);
    if (filter.minPnl) qs.set("minPnl", filter.minPnl);
    if (filter.maxPnl) qs.set("maxPnl", filter.maxPnl);
    const [a, p, o, c] = await Promise.all([
      api<Account>("/v1/account"),
      api<Portfolio>(`/v1/portfolio?range=${range}&group=${group}&protocol=${proto}`),
      api<{ positions: PfPosition[] }>("/v1/portfolio/positions?status=open"),
      api<{ positions: PfPosition[]; pools: Array<{ pool: string; token: string | null }> }>(`/v1/portfolio/positions?${qs}`),
    ]);
    setAcc(a);
    setPf(p);
    // Position Sounds: a chime when a position opens or closes while this page is open.
    const ids = new Set(o.positions.map((x) => x.id));
    if (openIds.current && soundsOn()) {
      if ([...ids].some((id) => !openIds.current!.has(id))) chime("open");
      else if ([...openIds.current].some((id) => !ids.has(id))) chime("close");
    }
    openIds.current = ids;
    setOpen(o.positions);
    setClosed(c);
    setUpdated(new Date().toISOString());
  }, [range, group, proto, filter]);

  useEffect(() => {
    void load().catch(() => undefined);
    // LP Agent refreshes open positions every 10 s and when the tab comes back.
    const t = setInterval(() => document.visibilityState === "visible" && void load().catch(() => undefined), 10_000);
    const vis = () => document.visibilityState === "visible" && void load().catch(() => undefined);
    document.addEventListener("visibilitychange", vis);
    return () => (clearInterval(t), document.removeEventListener("visibilitychange", vis));
  }, [load]);

  const actions: RowActions = {
    open: (p) => setDetail(p.id),
    exits: (p) => setExits(p),
    menu: (p) =>
      p.state === "ACTIVE"
        ? [
            { label: "Details", onClick: () => setDetail(p.id) },
            { label: "Claim fees", onClick: () => setAction({ p, kind: "claim" }) },
            { label: "Compound", onClick: () => setAction({ p, kind: "compound" }), disabled: p.protocol !== "dlmm" },
            { label: "Decrease", onClick: () => setAction({ p, kind: "decrease" }) },
            { label: "TP / SL", onClick: () => setExits(p) },
            { label: "Share PnL", onClick: () => setShare(p) },
            { label: "Zap out (SOL)", onClick: () => setAction({ p, kind: "close" }), danger: true },
          ]
        : [
            { label: "Details", onClick: () => setDetail(p.id) },
            { label: "Share PnL", onClick: () => setShare(p) },
            ...(p.position ? [{ label: "View on Solscan", onClick: () => window.open(`https://solscan.io/account/${p.position}`, "_blank") }] : []),
          ],
  };
  const done = (msg: string) => {
    setAction(null);
    setExits(null);
    setToast(msg);
    setTimeout(() => setToast(null), 5000);
    void load().catch(() => undefined);
  };

  const s = pf?.summary;
  return (
    <main className="page page-wide" lang="en">
      <div className="pf-head">
        <div className="pf-addr">
          <span className="mono">{acc?.wallet ?? "No agent wallet yet"}</span>
          {acc?.wallet && <button className="btn btn-sm btn-ghost" onClick={() => navigator.clipboard.writeText(acc.wallet!)} title="Kopyala" aria-label="Adresi kopyala">⧉</button>}
          <span className="badge">◎ Solana</span>
          {acc?.mode === "dry_run" && <span className="badge badge-dry">dry run</span>}
        </div>
        <div className="pf-sub muted small">
          {acc?.wallet && (
            <>
              Görüntüle:{" "}
              <a href={`https://solscan.io/account/${acc.wallet}`} target="_blank" rel="noreferrer">Solscan</a> ·{" "}
              <a href={`https://jup.ag/portfolio/${acc.wallet}`} target="_blank" rel="noreferrer">Jupiter</a> ·{" "}
            </>
          )}
          <button className="btn btn-sm btn-ghost" onClick={() => void load()} aria-label="Yenile">⟳</button> Son güncelleme: {updated ? ago(updated) : "—"}
        </div>
      </div>

      <section className="card pf-top">
        <div className="pf-metrics">
          <div className="pf-networth">
            <div className="kpi-label" title="Cüzdandaki SOL + token'lar + açık pozisyonlar + bekleyen fee'ler">NET WORTH</div>
            <div className="kpi-big"><NetWorth acc={acc} /></div>
            {!!acc?.dryRunValue && <div className="small muted">+ <Amount sol={acc.dryRunValue} d={2} /> dry run (sayılmaz)</div>}
          </div>
          <Kpi label="CLOSED" v={s ? String(s.totalClosed) : "—"} />
          <Kpi label="WIN RATE" v={s?.winRate === null || !s ? "—" : `${s.winRate.toFixed(2)}%`} cls={s?.winRate != null ? (s.winRate >= 50 ? "pos" : "neg") : ""} />
          <Kpi label="AVG INVESTED" v={<Amount sol={s?.avgInvested ?? null} d={2} />} />
          <Kpi label="FEE EARNED" v={<Amount sol={s?.feeEarned ?? null} d={2} />} cls="pos" />
          <Kpi label="TOTAL PROFIT" v={<Amount sol={s?.totalProfit ?? null} d={2} />} cls={tone(s?.totalProfit)} />
          <Kpi label="AVG MONTHLY PROFIT" v={<Amount sol={s?.avgMonthlyProfit ?? null} d={2} />} cls={tone(s?.avgMonthlyProfit)} />
          <Kpi label="EXPECTED VALUE (EV)" v={<Amount sol={s?.expectedValue ?? null} d={2} />} cls={tone(s?.expectedValue)} title="(kazanma oranı × ort. kazanç) + (kaybetme oranı × ort. kayıp)" />
        </div>
        <div className="pf-chart">
          <div className="kpi-label" title={metric === "pnl" ? "Kapanan pozisyonların kâr/zararı, kapanış gününe göre" : "Kapanan pozisyonların toplam fee'si, pozisyonun kapandığı güne yazılır (açık pozisyondan o gün claim edilen fee burada görünmez)"}>{metric === "pnl" ? "PROFIT HISTORY (CLOSED)" : "FEES OF CLOSED POSITIONS"}</div>
          {pf && (
            <FeeHistory
              metric={metric} setMetric={setMetric} group={group} setGroup={setGroup} range={range} setRange={setRange} proto={proto} setProto={setProto}
              series={metric === "pnl" ? pf.history.pnl : pf.history.fee} days={pf.days} feeDays={pf.feeDays ?? []}
            />
          )}
        </div>
      </section>

      <OpenPositions list={open} actions={actions} />
      <HistoricalPositions list={closed.positions} pools={closed.pools} filter={filter} setFilter={setFilter} actions={actions} />

      {detail && <PositionDrawer id={detail} onClose={() => setDetail(null)} />}
      {action && <ActionDialog p={action.p} kind={action.kind} onClose={() => setAction(null)} onDone={done} />}
      {exits && <ExitsDialog p={exits} onClose={() => setExits(null)} onDone={done} />}
      {share && <ShareCard p={share} onClose={() => setShare(null)} />}
      {toast && <div className="toast">{toast}</div>}
    </main>
  );
}

function Kpi({ label, v, cls = "", title }: { label: string; v: React.ReactNode; cls?: string; title?: string }) {
  return (
    <div title={title}>
      <div className="kpi-label">{label}</div>
      <div className={`kpi-value ${cls}`}>{v}</div>
    </div>
  );
}
