"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { MODE_TR, reasonTr, short, solFmt, time } from "@/lib/format";
import type { Position } from "@/lib/types";

const STATES = [
  { id: "ACTIVE", label: "Açık" },
  { id: "CLOSED", label: "Kapalı" },
  { id: "all", label: "Tümü" },
] as const;

export default function PositionsPage() {
  const [state, setState] = useState<(typeof STATES)[number]["id"]>("ACTIVE");
  const [rows, setRows] = useState<Position[]>([]);
  useEffect(() => {
    void api<Position[]>(`/v1/positions?state=${state}`).then(setRows).catch(() => undefined);
    const t = setInterval(() => void api<Position[]>(`/v1/positions?state=${state}`).then(setRows).catch(() => undefined), 30_000);
    return () => clearInterval(t);
  }, [state]);

  return (
    <main className="page">
      <div className="page-head"><h1>Pozisyonlar</h1></div>
      <div className="tabs">
        {STATES.map((s) => (
          <button key={s.id} className={`tab ${state === s.id ? "active" : ""}`} onClick={() => setState(s.id)}>{s.label}</button>
        ))}
      </div>
      <div className="card table-wrap">
        <table>
          <thead>
            <tr><th>Kaynak</th><th>Havuz</th><th>Yönetim</th><th>Aralık</th><th className="num">Yatırılan</th><th className="num">Güncel</th><th className="num">PnL</th><th>Durum</th><th>Açılış</th></tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id}>
                <td>
                  <div style={{ fontWeight: 600 }}>{p.source}</div>
                  {p.dryRun ? <span className="badge badge-dry">deneme</span> : <span className="mono muted">{short(p.ourPosition, 6)}</span>}
                </td>
                <td className="mono">
                  <a href={`https://app.meteora.ag/dlmm/${p.pool}`} target="_blank" rel="noreferrer">{short(p.pool, 6)}</a>
                </td>
                <td>{MODE_TR[p.managementMode]}{p.strategy ? <div className="muted small">{p.strategy}</div> : null}</td>
                <td className="mono muted">{p.range[0]}..{p.range[1]}</td>
                <td className="num">{solFmt(p.depositedSol)}</td>
                <td className="num">{solFmt(p.valueSol)}</td>
                <td className={`num ${p.pnlPct === null ? "" : p.pnlPct >= 0 ? "pos" : "neg"}`}>{p.pnlPct === null ? "—" : `${p.pnlPct >= 0 ? "+" : ""}${p.pnlPct.toFixed(2)}%`}</td>
                <td>
                  <span className={`badge ${p.state === "ACTIVE" ? "badge-accent" : ""}`}>{p.state === "ACTIVE" ? "Açık" : p.state === "OPENING" ? "Açılıyor" : p.state === "CLOSED" ? "Kapalı" : p.state}</span>
                  {p.closeReason && <div className="muted small">{reasonTr(p.closeReason)}</div>}
                  {p.flips ? <div className="muted small">{p.flips} flip</div> : null}
                </td>
                <td className="muted num">{p.openedAt ? time(p.openedAt) : "—"}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={9} className="empty">Pozisyon yok.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="muted small">Değerler her 30 saniyede manager tarafından güncellenir. Deneme modundaki pozisyonlar zincirde yoktur; gerçek havuz fiyatıyla simüle edilir.</p>
    </main>
  );
}
