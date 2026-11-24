"use client";

import { useEffect, useRef, useState } from "react";
import { compact } from "@/components/Num";

/** Shared pieces of the LP Agent-style market tables (Discover, Pools). */

export const usd = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `$${compact(v, v >= 1000 ? 0 : 2)}`);

/** $0.0₄6079: leading zeros after "0." collapsed into a subscript count, like LP Agent. */
export function Price({ v }: { v: number }) {
  if (!Number.isFinite(v) || v <= 0) return <>—</>;
  if (v >= 1) return <>${v.toFixed(v >= 1000 ? 0 : 2)}</>;
  if (v >= 0.001) return <>${v.toPrecision(4).replace(/0+$/, "")}</>;
  const s = v.toFixed(20).slice(2);
  const zeros = s.match(/^0*/)![0].length;
  return (
    <>
      $0.0<sub className="zeros">{zeros}</sub>
      {s.slice(zeros, zeros + 4)}
    </>
  );
}

/** Signed % change under a value; "--" when unknown. */
export function Chg({ v, d = 1 }: { v: number | null | undefined; d?: number }) {
  if (v === null || v === undefined || !Number.isFinite(v)) return <div className="chg muted">--</div>;
  const s = Math.abs(v) >= 1_000 ? Math.round(v).toLocaleString("en-US") : v.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });
  return <div className={`chg ${v >= 0 ? "pos" : "neg"}`}>{v >= 0 ? "+" : ""}{s}%</div>;
}

/** Short English age: 17m, 9h, 2d, 2mo, 1y. */
export function ageShort(hours: number | null | undefined): string {
  if (hours === null || hours === undefined || !Number.isFinite(hours)) return "—";
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  const d = hours / 24;
  if (d < 60) return `${Math.round(d)}d`;
  if (d < 365) return `${Math.round(d / 30)}mo`;
  return `${(d / 365).toFixed(1)}y`;
}
export const ageOfIso = (iso: string | null | undefined) => (iso ? ageShort((Date.now() - Date.parse(iso)) / 3_600_000) : "—");

/** Tiny price line; green when it ends above where it started. */
export function Spark({ points, w = 76, h = 28 }: { points: number[]; w?: number; h?: number }) {
  if (points.length < 2) return <svg width={w} height={h} aria-hidden />;
  const lo = Math.min(...points), hi = Math.max(...points);
  const span = hi - lo || 1;
  const path = points.map((p, i) => `${i ? "L" : "M"}${((i / (points.length - 1)) * (w - 2) + 1).toFixed(1)},${(h - 2 - ((p - lo) / span) * (h - 4)).toFixed(1)}`).join(" ");
  return (
    <svg width={w} height={h} className={points[points.length - 1]! >= points[0]! ? "spark up" : "spark down"} aria-hidden>
      <path d={path} fill="none" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

/** Jupiter organic score with the leaf icon. */
export function Leaf({ score }: { score: number | null | undefined }) {
  if (score === null || score === undefined) return null;
  return (
    <span className="leaf" title="Organic score (Jupiter): gerçek kullanıcı işlemi oranı">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
        <path d="M5 19c0-8 5-13 14-14-1 9-6 14-14 14z" />
        <path d="M5 19l7-7" />
      </svg>
      {Math.round(score)}
    </span>
  );
}

export function CopyBtn({ text }: { text: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      className="copy-btn"
      title="Kopyala"
      aria-label="Adresi kopyala"
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard.writeText(text).then(() => (setOk(true), setTimeout(() => setOk(false), 1200)));
      }}
    >
      {ok ? "✓" : "⧉"}
    </button>
  );
}

export function TokenIcon({ icon, symbol, size = 32 }: { icon: string | null | undefined; symbol: string | null | undefined; size?: number }) {
  return (
    <span className="tok-icon" style={{ width: size, height: size }}>
      <span className="tok-ph">{(symbol ?? "?").slice(0, 1)}</span>
      {icon && <img src={icon} alt="" onError={(e) => (e.currentTarget.style.display = "none")} />}
    </span>
  );
}

/** Columns 10/15: which optional columns are shown, remembered per browser. */
export function useColumns<K extends string>(storageKey: string, all: ReadonlyArray<{ id: K; label: string; on: boolean }>) {
  const [shown, setShown] = useState<Set<K>>(() => new Set(all.filter((c) => c.on).map((c) => c.id)));
  useEffect(() => {
    try {
      const v = JSON.parse(localStorage.getItem(storageKey) ?? "null") as K[] | null;
      if (Array.isArray(v)) setShown(new Set(v.filter((id) => all.some((c) => c.id === id))));
    } catch {
      /* storage blocked */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);
  const toggle = (id: K) =>
    setShown((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      try {
        localStorage.setItem(storageKey, JSON.stringify([...n]));
      } catch {
        /* storage blocked */
      }
      return n;
    });
  return { shown, toggle, has: (id: K) => shown.has(id) };
}

export function ColumnsPicker<K extends string>({ all, shown, toggle }: { all: ReadonlyArray<{ id: K; label: string }>; shown: Set<K>; toggle: (id: K) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <div className="pop-wrap" ref={ref}>
      <button className="btn btn-sm tool-btn" onClick={() => setOpen(!open)}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16M15 4v16" /></svg>
        Columns <span className="muted">{shown.size}/{all.length}</span>
      </button>
      {open && (
        <div className="pop cols-pop">
          {all.map((c) => (
            <label key={c.id} className="check"><input type="checkbox" checked={shown.has(c.id)} onChange={() => toggle(c.id)} /><span>{c.label}</span></label>
          ))}
        </div>
      )}
    </div>
  );
}

export function FilterIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M4 6h16M7 12h10M10 18h4" /></svg>;
}

/** "Updated a few seconds ago" with a live dot. */
export function Updated({ at }: { at: string | null | undefined }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, []);
  if (!at) return <span className="muted small">Yükleniyor…</span>;
  const s = (Date.now() - Date.parse(at)) / 1000;
  const txt = s < 45 ? "a few seconds ago" : s < 90 ? "a minute ago" : s < 3600 ? `${Math.round(s / 60)} minutes ago` : `${Math.round(s / 3600)} hours ago`;
  return <span className="updated"><i />Updated {txt}</span>;
}
