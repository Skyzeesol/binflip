"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, post } from "@/lib/api";
import { short } from "@/lib/format";
import type { Me, Risk } from "@/lib/types";
import { AccountPanel } from "@/components/AccountPanel";
import { useCurrency } from "@/lib/currency";

const NAV = [
  { href: "/pools", label: "Havuzlar" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/", label: "Copy LP" },
  { href: "/settings", label: "Ayarlar" },
];

export function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const [me, setMe] = useState<Me | null>(null);
  const [risk, setRisk] = useState<Risk | null>(null);
  const { cur, setCur } = useCurrency();

  const load = useCallback(async () => {
    const [m, r] = await Promise.all([api<Me>("/v1/me"), api<Risk>("/v1/risk")]);
    setMe(m);
    setRisk(r);
  }, []);
  useEffect(() => {
    void load().catch(() => undefined);
  }, [load]);

  const toggleKill = async () => {
    if (!risk) return;
    if (!risk.killSwitch && !confirm("Acil durdurma: yeni açma, ekleme, flip ve compound durur. Çıkışlar liderleri takip etmeye devam eder. Emin misiniz?")) return;
    await post(risk.killSwitch ? "/v1/unkill" : "/v1/kill", { reason: "panel" });
    await load();
  };

  const logout = async () => {
    await post("/v1/auth/logout");
    window.location.href = "/login";
  };

  return (
    <>
      <header className="topbar">
        <Link href="/" className="brand">
          <span className="brand-dot" /> Binflip
        </Link>
        <nav className="nav">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className={path === n.href || (n.href !== "/" && path.startsWith(n.href)) ? "active" : ""}>
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="spacer" />
        <SearchBox />
        {me && (
          <span className={`badge ${me.mode === "live" ? "badge-live" : "badge-dry"}`} title={me.mode === "live" ? "Gerçek işlemler imzalanıyor" : "Hiçbir işlem imzalanmıyor"}>
            <span className="dot" /> {me.mode === "live" ? "CANLI" : "DENEME"}
          </span>
        )}
        {risk && (
          <button className={`btn btn-sm btn-danger ${risk.killSwitch ? "on" : ""}`} onClick={toggleKill}>
            {risk.killSwitch ? "Durduruldu — devam et" : "Acil durdur"}
          </button>
        )}
        <div className="seg cur-toggle" title="Tutarları SOL ya da USD göster">
          <button className={cur === "sol" ? "on" : ""} onClick={() => setCur("sol")} aria-label="SOL">◎</button>
          <button className={cur === "usd" ? "on" : ""} onClick={() => setCur("usd")} aria-label="USD">$</button>
        </div>
        {me && <AccountPanel me={me} onLogout={logout} />}
      </header>
      {risk?.fundProtectionTrippedAt && (
        <div className="page" style={{ paddingBottom: 0 }}>
          <div className="banner banner-neg">
            Durduruldu: zarar limiti doldu. Yeni açma, ekleme, compound ve flip yapılmıyor; çıkışlar liderleri takip ediyor.
            <div className="spacer" />
            <Link className="btn btn-sm" href="/settings#limits">Limit / Devam et</Link>
          </div>
        </div>
      )}
      {risk?.killSwitch && (
        <div className="page" style={{ paddingBottom: 0 }}>
          <div className="banner banner-neg">Acil durdurma açık: yeni girişler yapılmıyor, çıkışlar liderleri takip ediyor.</div>
        </div>
      )}
      {children}
    </>
  );
}

/** LP Agent "Search anything" (shortcut /): paste a pool, token or wallet address. */
function SearchBox() {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "/" && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        document.getElementById("global-search")?.focus();
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);
  const go = async (e: React.FormEvent) => {
    e.preventDefault();
    const v = q.trim();
    if (!v) return;
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v)) {
      window.location.href = `/pools?q=${encodeURIComponent(v)}`;
      return;
    }
    setBusy(true);
    try {
      const r = await api<{ href: string }>(`/v1/resolve/${v}`);
      window.location.href = r.href;
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={go} className="search hide-sm" role="search">
      <input id="global-search" type="text" placeholder={busy ? "Aranıyor…" : "Havuz, token ya da cüzdan ara  /"} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Ara" />
    </form>
  );
}
