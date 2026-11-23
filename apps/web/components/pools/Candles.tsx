"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";

export type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };
const TFS = ["1m", "5m", "15m", "30m", "1h", "4h", "12h", "24h"] as const;

/** Price candles (pool's own trades, in SOL) with optional Min/Max price lines for a range. */
export function CandleChart({ pool, protocol, lines, height = 340 }: { pool: string; protocol: string; lines?: { min: number; max: number } | null; height?: number }) {
  const [tf, setTf] = useState<(typeof TFS)[number]>("5m");
  const [data, setData] = useState<Candle[]>([]);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      void api<{ candles: Candle[] }>(`/v1/pools/${pool}/candles?tf=${tf}&protocol=${protocol}`)
        .then((r) => live && (setData(r.candles.slice(-150)), setErr(null)))
        .catch((e) => live && setErr((e as Error).message));
    load();
    const t = setInterval(load, 30_000);
    return () => ((live = false), clearInterval(t));
  }, [pool, protocol, tf]);

  const W = 900, H = height, P = { l: 8, r: 70, t: 12, b: 22 };
  const view = useMemo(() => {
    if (!data.length) return null;
    let lo = Math.min(...data.map((d) => d.l));
    let hi = Math.max(...data.map((d) => d.h));
    if (lines) {
      lo = Math.min(lo, lines.min);
      hi = Math.max(hi, lines.max);
    }
    const pad = (hi - lo) * 0.06 || hi * 0.05;
    return { lo: lo - pad, hi: hi + pad, vmax: Math.max(...data.map((d) => d.v), 1e-12) };
  }, [data, lines]);

  const y = (v: number) => (view ? P.t + ((view.hi - v) / (view.hi - view.lo)) * (H - P.t - P.b) : 0);
  const cw = (W - P.l - P.r) / Math.max(data.length, 1);
  const fmt = (v: number) => (v >= 1 ? v.toFixed(4) : v.toPrecision(4));

  return (
    <div className="candles">
      <div className="candles-bar">
        {TFS.map((t) => (
          <button key={t} className={tf === t ? "on" : ""} onClick={() => setTf(t)}>{t}</button>
        ))}
        <span className="spacer" />
        {data.length > 0 && <span className="small muted">son: {fmt(data[data.length - 1]!.c)} SOL</span>}
      </div>
      {err && <div className="note">Grafik verisi alınamadı: {err}</div>}
      {!view && !err && <div className="empty small">Grafik yükleniyor…</div>}
      {view && (
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Fiyat grafiği">
          {[0, 0.25, 0.5, 0.75, 1].map((k) => {
            const v = view.lo + (view.hi - view.lo) * k;
            return (
              <g key={k}>
                <line x1={P.l} x2={W - P.r} y1={y(v)} y2={y(v)} stroke="var(--border)" strokeDasharray="2 4" />
                <text x={W - P.r + 6} y={y(v) + 4} fontSize="11" fill="var(--muted)">{fmt(v)}</text>
              </g>
            );
          })}
          {lines && (
            <g>
              <rect x={P.l} y={y(lines.max)} width={W - P.l - P.r} height={Math.max(1, y(lines.min) - y(lines.max))} fill="#f5c542" opacity="0.08" />
              {[{ v: lines.max, l: "Max" }, { v: lines.min, l: "Min" }].map((x) => (
                <g key={x.l}>
                  <line x1={P.l} x2={W - P.r} y1={y(x.v)} y2={y(x.v)} stroke="#f5c542" strokeWidth="1.2" />
                  <rect x={W - P.r - 64} y={y(x.v) - 9} width="62" height="18" rx="3" fill="#f5c542" />
                  <text x={W - P.r - 33} y={y(x.v) + 4} fontSize="11" textAnchor="middle" fill="#111" fontWeight="700">{x.l} fiyat</text>
                </g>
              ))}
            </g>
          )}
          {data.map((d, i) => {
            const x = P.l + i * cw + cw / 2;
            const up = d.c >= d.o;
            const col = up ? "var(--pos)" : "var(--neg)";
            const vh = (d.v / view.vmax) * (H * 0.18);
            return (
              <g key={d.t}>
                <rect x={x - cw * 0.35} y={H - P.b - vh} width={cw * 0.7} height={vh} fill={col} opacity="0.18" />
                <line x1={x} x2={x} y1={y(d.h)} y2={y(d.l)} stroke={col} strokeWidth="1" />
                <rect x={x - cw * 0.35} y={y(Math.max(d.o, d.c))} width={Math.max(1, cw * 0.7)} height={Math.max(1, Math.abs(y(d.o) - y(d.c)))} fill={col}>
                  <title>{`${new Date(d.t * 1000).toLocaleString("tr-TR")}\nA ${fmt(d.o)} Y ${fmt(d.h)} D ${fmt(d.l)} K ${fmt(d.c)}`}</title>
                </rect>
              </g>
            );
          })}
          <text x={P.l} y={H - 6} fontSize="11" fill="var(--muted)">{new Date(data[0]!.t * 1000).toLocaleString("tr-TR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</text>
          <text x={W - P.r} y={H - 6} fontSize="11" fill="var(--muted)" textAnchor="end">{new Date(data[data.length - 1]!.t * 1000).toLocaleString("tr-TR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</text>
        </svg>
      )}
    </div>
  );
}
