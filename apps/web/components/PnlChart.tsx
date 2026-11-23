"use client";

const PALETTE = ["var(--accent)", "#e0861a", "#1aa37a", "#c4459a", "#3b8fd9", "#8a6d3b"];

/** Cumulative PnL per wallet as a small inline SVG line chart (no chart library). */
export function PnlChart({ series, labelOf }: { series: Array<{ day: string; leaderId: string | null; pnlSol: number }>; labelOf: (id: string | null) => string }) {
  if (!series.length) return <div className="empty small">Grafik için henüz yeterli veri yok. Manager her 5 dakikada bir değer kaydeder.</div>;

  const days = [...new Set(series.map((s) => s.day))].sort();
  const ids = [...new Set(series.map((s) => s.leaderId))];
  const lines = ids.map((id) => days.map((d) => series.find((s) => s.day === d && s.leaderId === id)?.pnlSol ?? null));
  const values = lines.flat().filter((v): v is number => v !== null);
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const span = Math.max(Math.abs(min), Math.abs(max));
  const dec = span < 0.1 ? 4 : span < 10 ? 3 : 2;
  const W = 800, H = 220, P = 28;
  const x = (i: number) => P + (days.length === 1 ? (W - 2 * P) / 2 : (i * (W - 2 * P)) / (days.length - 1));
  const y = (v: number) => H - P - ((v - min) / (max - min || 1)) * (H - 2 * P);

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Kümülatif PnL">
        <line x1={P} x2={W - P} y1={y(0)} y2={y(0)} stroke="var(--border)" strokeDasharray="4 4" />
        <text x={4} y={y(max) + 4} fontSize="11" fill="var(--muted)">{max.toFixed(dec)}</text>
        <text x={4} y={y(min) + 4} fontSize="11" fill="var(--muted)">{min.toFixed(dec)}</text>
        {lines.map((pts, li) => {
          const d = pts
            .map((v, i) => (v === null ? null : `${x(i)},${y(v)}`))
            .filter(Boolean)
            .join(" L ");
          return d ? <path key={li} d={`M ${d}`} fill="none" stroke={PALETTE[li % PALETTE.length]} strokeWidth="2.5" strokeLinejoin="round" /> : null;
        })}
        {days.map((d, i) => (i === 0 || i === days.length - 1 ? <text key={d} x={x(i)} y={H - 6} fontSize="11" fill="var(--muted)" textAnchor="middle">{d.slice(5)}</text> : null))}
      </svg>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }} className="small">
        {ids.map((id, i) => (
          <span key={id ?? "m"} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 10, height: 3, background: PALETTE[i % PALETTE.length], display: "inline-block", borderRadius: 2 }} />
            {labelOf(id)}
          </span>
        ))}
      </div>
    </div>
  );
}
