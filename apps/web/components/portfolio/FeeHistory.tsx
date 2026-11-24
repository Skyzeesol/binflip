"use client";

import { useMemo, useState } from "react";
import type { PfBucket } from "@/lib/types";
import { Amount, compact } from "@/components/Num";
import { useCurrency } from "@/lib/currency";

export type Metric = "pnl" | "fee";
export type Group = "day" | "week" | "month";
export type Range = "7D" | "MTD" | "1M" | "3M" | "1Y" | "YTD" | "ALL";
export type Proto = "all" | "dlmm" | "damm_v2";

const DOW = ["Paz", "Pzt", "Sal", "Çar", "Per", "Cum", "Cmt"];
const MONTHS = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"];

/** LP Agent "Profit history": PnL / Fee, protocol filter, chart or calendar, D/W/M, range. */
export function FeeHistory(p: {
  metric: Metric;
  setMetric: (m: Metric) => void;
  group: Group;
  setGroup: (g: Group) => void;
  range: Range;
  setRange: (r: Range) => void;
  proto: Proto;
  setProto: (p: Proto) => void;
  series: PfBucket[];
  days: PfBucket[];
  feeDays: PfBucket[];
}) {
  const [view, setView] = useState<"chart" | "calendar">("calendar");
  const total = p.series.reduce((s, b) => s + b.value, 0);
  return (
    <div className="pf-history">
      <div className="pf-history-bar">
        <div className="seg">
          <button className={p.metric === "pnl" ? "on" : ""} onClick={() => p.setMetric("pnl")}>PnL</button>
          <button className={p.metric === "fee" ? "on" : ""} onClick={() => p.setMetric("fee")}>Fee</button>
        </div>
        <div className="spacer" />
        <select className="sel" value={p.proto} onChange={(e) => p.setProto(e.target.value as Proto)}>
          <option value="all">All protocols</option>
          <option value="dlmm">DLMM</option>
          <option value="damm_v2">DAMM V2</option>
        </select>
        <div className="seg icons">
          <button className={view === "chart" ? "on" : ""} onClick={() => setView("chart")} title="Grafik" aria-label="Grafik">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3v18h18" /><path d="m7 15 4-4 3 3 5-6" /></svg>
          </button>
          <button className={view === "calendar" ? "on" : ""} onClick={() => setView("calendar")} title="Takvim" aria-label="Takvim">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></svg>
          </button>
        </div>
        <select className="sel" value={p.group} disabled={view === "calendar"} onChange={(e) => p.setGroup(e.target.value as Group)}>
          <option value="day">Daily</option>
          <option value="week">Weekly</option>
          <option value="month">Monthly</option>
        </select>
        <select className="sel" value={p.range} onChange={(e) => p.setRange(e.target.value as Range)}>
          {(["7D", "MTD", "1M", "3M", "1Y", "YTD", "ALL"] as const).map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
      </div>
      {view === "chart" ? <Bars series={p.series} /> : <Calendar days={p.metric === "pnl" ? p.days : p.feeDays} />}
      <div className="pf-history-foot">
        <span className="muted">{p.metric === "pnl" ? "Total profit" : "Total fee"}</span>{" "}
        <Amount sol={total} d={2} className={total >= 0 ? "pos" : "neg"} />
      </div>
    </div>
  );
}

function Bars({ series }: { series: PfBucket[] }) {
  const { cur, solUsd } = useCurrency();
  if (!series.length) return <div className="empty small">Bu aralıkta kapanan pozisyon yok.</div>;
  const k = cur === "usd" && solUsd ? solUsd : 1;
  const vals = series.map((s) => s.value * k);
  const max = Math.max(0, ...vals);
  const min = Math.min(0, ...vals);
  const W = 640, H = 240, P = 30;
  const bw = Math.max(4, Math.min(28, (W - 2 * P) / series.length - 4));
  const y = (v: number) => P + ((max - v) / (max - min || 1)) * (H - 2 * P);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Kâr geçmişi">
      <line x1={P} x2={W - 8} y1={y(0)} y2={y(0)} stroke="var(--border)" />
      <text x={2} y={y(max) + 4} fontSize="10" fill="var(--muted)">{compact(max, 2)}</text>
      <text x={2} y={y(min) + 4} fontSize="10" fill="var(--muted)">{compact(min, 2)}</text>
      {series.map((s, i) => {
        const v = vals[i]!;
        const x = P + i * ((W - P - 8) / series.length) + 2;
        return (
          <g key={s.bucket}>
            <rect x={x} y={Math.min(y(v), y(0))} width={bw} height={Math.max(1, Math.abs(y(v) - y(0)))} rx="2" fill={v >= 0 ? "var(--pos)" : "var(--neg)"}>
              <title>{`${s.bucket}: ${v.toFixed(4)} (${s.count} pozisyon)`}</title>
            </rect>
            {(i === 0 || i === series.length - 1) && <text x={x + bw / 2} y={H - 8} fontSize="10" fill="var(--muted)" textAnchor="middle">{s.bucket.slice(5)}</text>}
          </g>
        );
      })}
    </svg>
  );
}

function Calendar({ days }: { days: PfBucket[] }) {
  const now = new Date();
  const [ym, setYm] = useState({ y: now.getUTCFullYear(), m: now.getUTCMonth() });
  const byDay = useMemo(() => new Map(days.map((d) => [d.bucket, d.value])), [days]);
  const first = new Date(Date.UTC(ym.y, ym.m, 1));
  const n = new Date(Date.UTC(ym.y, ym.m + 1, 0)).getUTCDate();
  const cells: Array<number | null> = [...Array(first.getUTCDay()).fill(null), ...Array.from({ length: n }, (_, i) => i + 1)];
  const move = (d: number) => setYm(({ y, m }) => ({ y: m + d < 0 ? y - 1 : m + d > 11 ? y + 1 : y, m: (m + d + 12) % 12 }));
  return (
    <div className="cal">
      <div className="cal-head">
        <button className="btn btn-sm btn-ghost" onClick={() => move(-1)} aria-label="Önceki ay">‹</button>
        <b>{MONTHS[ym.m]} {ym.y}</b>
        <button className="btn btn-sm btn-ghost" onClick={() => move(1)} aria-label="Sonraki ay">›</button>
      </div>
      <div className="cal-grid">
        {DOW.map((d) => <div key={d} className="cal-dow">{d}</div>)}
        {cells.map((d, i) => {
          if (d === null) return <div key={`e${i}`} />;
          const key = `${ym.y}-${String(ym.m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
          const v = byDay.get(key);
          return (
            <div key={key} className={`cal-day ${v === undefined ? "" : v >= 0 ? "up" : "down"}`}>
              <span>{d}</span>
              {v !== undefined && <Amount sol={v} d={4} className={v >= 0 ? "pos" : "neg"} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}
