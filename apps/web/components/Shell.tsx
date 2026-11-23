"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, post } from "@/lib/api";
import { short } from "@/lib/format";
import type { Me, Risk } from "@/lib/types";

const NAV = [
  { href: "/", label: "Copy LP" },
  { href: "/positions", label: "Pozisyonlar" },
  { href: "/settings", label: "Ayarlar" },
];

export function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const [me, setMe] = useState<Me | null>(null);
  const [risk, setRisk] = useState<Risk | null>(null);

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
            <Link key={n.href} href={n.href} className={path === n.href ? "active" : ""}>
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="spacer" />
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
        {me && (
          <button className="btn btn-sm btn-ghost hide-sm" onClick={logout} title={me.user.loginWallet}>
            {short(me.user.loginWallet)} · Çıkış
          </button>
        )}
      </header>
      {risk?.killSwitch && (
        <div className="page" style={{ paddingBottom: 0 }}>
          <div className="banner banner-neg">Acil durdurma açık: yeni girişler yapılmıyor, çıkışlar liderleri takip ediyor.</div>
        </div>
      )}
      {children}
    </>
  );
}
