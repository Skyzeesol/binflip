"use client";

import { useCurrency } from "@/lib/currency";

/** Small SOL mark, like the token logo next to amounts in LP Agent. */
export function SolMark({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-label="SOL" style={{ verticalAlign: "-2px", flex: "none" }}>
      <defs>
        <linearGradient id="solg" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#9945ff" />
          <stop offset="1" stopColor="#14f195" />
        </linearGradient>
      </defs>
      <circle cx="12" cy="12" r="12" fill="#101014" />
      <path d="M7 15.5h9.5l-1.6 1.6H5.4zM7 11.2h9.5l-1.6 1.6H5.4zM8.6 7h9.5l-1.6 1.6H7z" fill="url(#solg)" />
    </svg>
  );
}

/** Compact number: 1.72k, 3.10k%, < 0.01 for dust (LP Agent style). */
export function compact(v: number, d = 4): string {
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)}m`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(2)}k`;
  if (a > 0 && a < 1 / 10 ** Math.min(d, 2)) return `< ${(1 / 10 ** Math.min(d, 2)).toFixed(Math.min(d, 2))}`;
  return v.toFixed(d);
}

/** An amount in SOL, shown in SOL (with the SOL mark) or USD depending on the "$" toggle. */
export function Amount({ sol, d = 4, signed = false, className = "" }: { sol: number | null | undefined; d?: number; signed?: boolean; className?: string }) {
  const { cur, solUsd } = useCurrency();
  if (sol === null || sol === undefined) return <span className={`muted ${className}`}>—</span>;
  if (cur === "usd" && solUsd) {
    const v = sol * solUsd;
    return <span className={`amt ${className}`}>{signed && v > 0 ? "+" : ""}${compact(v, 2)}</span>;
  }
  return (
    <span className={`amt ${className}`}>
      {signed && sol > 0 ? "+" : ""}
      {compact(sol, d)} <SolMark />
    </span>
  );
}

export function Pct({ v, d = 2, className = "" }: { v: number | null | undefined; d?: number; className?: string }) {
  if (v === null || v === undefined) return <span className="muted">—</span>;
  const a = Math.abs(v);
  const txt = a > 0 && a < 0.01 ? "< 0.01" : compact(v, d);
  return <span className={className}>{txt}%</span>;
}

export const tone = (v: number | null | undefined) => (v === null || v === undefined || v === 0 ? "" : v > 0 ? "pos" : "neg");

/** Age like LP Agent: 0.10h, 5.2h, 3.4d. */
export function age(ms: number | null): string {
  if (ms === null) return "—";
  const h = ms / 3_600_000;
  return h < 48 ? `${h.toFixed(2)}h` : `${(h / 24).toFixed(1)}d`;
}

/**
 * Net worth that is honest about a failed wallet read: the current total, else the last complete one
 * with its time, else "Bakiye alınamadı". Never the positions alone.
 */
export function NetWorth({ acc, d = 2 }: { acc: { netWorth: number | null; lastGood?: { netWorth: number; at: string } | null; error?: string } | null; d?: number }) {
  if (!acc) return <Amount sol={null} d={d} />;
  if (acc.netWorth !== null) return <Amount sol={acc.netWorth} d={d} />;
  if (acc.lastGood) {
    const t = new Date(acc.lastGood.at).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
    return (
      <span title={`Cüzdan şu an okunamadı (${acc.error ?? "RPC"}); ${t} itibarıyla son tam değer`}>
        <Amount sol={acc.lastGood.netWorth} d={d} /> <span className="small muted">({t} itibarıyla)</span>
      </span>
    );
  }
  return <span className="neg small" title={acc.error}>Bakiye alınamadı</span>;
}
