"use client";

import { useEffect, useState } from "react";
import { api, patch, put } from "@/lib/api";
import { MODE_TR, short } from "@/lib/format";
import type { ManagementMode, Me, Risk } from "@/lib/types";

interface Manual {
  enabled: boolean;
  mode: ManagementMode;
  flipThresholdPct: number;
  takeProfitPct: number | null;
  stopLossPct: number | null;
  trailingStopPct: number | null;
  compoundMinutes: number | null;
}

const num = (v: string) => (v.trim() === "" ? null : Number(v));
const str = (v: number | null | undefined) => (v === null || v === undefined ? "" : String(v));

export default function SettingsPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [risk, setRisk] = useState<Risk | null>(null);
  const [manual, setManual] = useState<Manual | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([api<Me>("/v1/me"), api<Risk>("/v1/risk"), api<Manual>("/v1/manual")]).then(([m, r, mn]) => {
      setMe(m);
      setRisk(r);
      setManual(mn);
    });
  }, []);

  const flash = (msg: string) => {
    setSaved(msg);
    setError(null);
    setTimeout(() => setSaved(null), 2500);
  };

  const saveRisk = async () => {
    if (!risk) return;
    try {
      await patch("/v1/risk", {
        maxSolPerTx: risk.maxSolPerTx,
        maxSolPerDay: risk.maxSolPerDay,
        fundProtectionEnabled: risk.fundProtectionEnabled,
        fundProtectionLossPct: risk.fundProtectionLossPct,
        slippagePct: risk.slippagePct,
        minOrganicScore: risk.minOrganicScore,
        minMarketCapUsd: risk.minMarketCapUsd,
        min24hVolumeUsd: risk.min24hVolumeUsd,
        minHolders: risk.minHolders,
        tokenBlacklist: risk.tokenBlacklist,
      });
      flash("Risk ayarları kaydedildi");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const saveManual = async () => {
    if (!manual) return;
    try {
      await put("/v1/manual", manual);
      flash("Manuel pozisyon ayarları kaydedildi");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!risk || !manual || !me) return <main className="page muted">Yükleniyor…</main>;
  const r = (k: keyof Risk, v: unknown) => setRisk({ ...risk, [k]: v } as Risk);
  const m = (k: keyof Manual, v: unknown) => setManual({ ...manual, [k]: v } as Manual);

  return (
    <main className="page stack">
      <div className="page-head">
        <h1>Ayarlar</h1>
        <div className="spacer" />
        {saved && <span className="badge badge-pos">{saved}</span>}
        {error && <span className="badge badge-neg">{error}</span>}
      </div>

      <section className="card card-pad stack">
        <h3 style={{ margin: 0 }}>Bot cüzdanı</h3>
        {me.agentWallets.length ? (
          me.agentWallets.map((w) => (
            <div key={w.id} style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <span style={{ fontWeight: 600 }}>{w.label}</span>
              <a className="mono" href={`https://solscan.io/account/${w.publicKey}`} target="_blank" rel="noreferrer">{w.publicKey}</a>
            </div>
          ))
        ) : (
          <p className="muted" style={{ margin: 0 }}>Henüz bot cüzdanı yok. Sunucuda <code>wallet:create</code> ile oluşturulur; panel hiçbir zaman özel anahtar istemez ya da göstermez.</p>
        )}
        <div className="note">Mod: <b>{me.mode === "live" ? "CANLI" : "DENEME"}</b>. Canlıya geçiş sadece sunucuda yapılır (<code>docker-compose.live.yml</code>); panelden açılamaz.</div>
      </section>

      <section className="card card-pad stack">
        <h3 style={{ margin: 0 }}>Limitler ve fon koruması</h3>
        <div className="row">
          <label className="field">İşlem başı en fazla (SOL)<input type="number" min={0} step="0.1" value={risk.maxSolPerTx} onChange={(e) => r("maxSolPerTx", Number(e.target.value))} /><span className="hint">Hiçbir açma/ekleme bunu geçemez (güvenlik sınırı).</span></label>
          <label className="field">Günlük en fazla (SOL)<input type="number" min={0} step="0.5" value={risk.maxSolPerDay} onChange={(e) => r("maxSolPerDay", Number(e.target.value))} /></label>
        </div>
        <label className="check"><input type="checkbox" checked={risk.fundProtectionEnabled} onChange={(e) => r("fundProtectionEnabled", e.target.checked)} /><span>Fon koruması<div className="hint">Kapanan kopyalardaki zarar, net varlığın bu yüzdesine ulaşınca yeni girişler durur; çıkışlar liderleri takip etmeye devam eder.{risk.fundProtectionTrippedAt ? " ŞU AN TETİKLENMİŞ." : ""}</div></span></label>
        <div className="row">
          <label className="field">Zirveden en fazla zarar (%)<input type="number" min={1} max={100} value={risk.fundProtectionLossPct} onChange={(e) => r("fundProtectionLossPct", Number(e.target.value))} /><span className="hint">Kaydetmek sayacı sıfırlar.</span></label>
          <label className="field">Slippage (%)<input type="number" min={0.1} max={50} step="0.1" value={risk.slippagePct} onChange={(e) => r("slippagePct", Number(e.target.value))} /><span className="hint">Bütün swap'lar için (çıkışta token → SOL dahil).{risk.slippagePct > 7 ? " %7 üstü yüksek." : ""}</span></label>
        </div>
      </section>

      <section className="card card-pad stack">
        <h3 style={{ margin: 0 }}>Token filtreleri</h3>
        <p className="muted small" style={{ margin: 0 }}>Bir token bunlardan birini geçemezse kopya atlanır. (Kaydedilir; fiyat verisi gerektiren filtreler sonraki sürümde uygulanacak.)</p>
        <div className="row">
          <label className="field">Jupiter Organic Score (en az)<input type="number" min={0} max={100} value={str(risk.minOrganicScore)} onChange={(e) => r("minOrganicScore", num(e.target.value))} /></label>
          <label className="field">Piyasa değeri (en az, $)<input type="number" min={0} step="10000" value={str(risk.minMarketCapUsd)} onChange={(e) => r("minMarketCapUsd", num(e.target.value))} /></label>
          <label className="field">24s hacim (en az, $)<input type="number" min={0} step="10000" value={str(risk.min24hVolumeUsd)} onChange={(e) => r("min24hVolumeUsd", num(e.target.value))} /></label>
          <label className="field">Holder (en az)<input type="number" min={0} value={str(risk.minHolders)} onChange={(e) => r("minHolders", num(e.target.value))} /></label>
        </div>
        <label className="field">Kara liste (her satıra bir token adresi)<textarea className="mono" value={risk.tokenBlacklist.join("\n")} onChange={(e) => r("tokenBlacklist", e.target.value.split(/\s+/).filter(Boolean))} /></label>
        <div><button className="btn btn-primary" onClick={saveRisk}>Limitleri ve filtreleri kaydet</button></div>
      </section>

      <section className="card card-pad stack">
        <h3 style={{ margin: 0 }}>Kendi açtığım pozisyonlar</h3>
        <p className="muted small" style={{ margin: 0 }}>Bot cüzdanını Phantom'a ekleyip kendiniz açtığınız pozisyonlar ~5 dakikada bir bulunur ve bu kurallarla yönetilir. PnL, yönetime alındığı andaki değerden ölçülür.</p>
        <label className="check"><input type="checkbox" checked={manual.enabled} onChange={(e) => m("enabled", e.target.checked)} /><span>Kendi pozisyonlarımı yönet</span></label>
        <div className="row">
          <label className="field">Yönetim modu<select value={manual.mode} onChange={(e) => m("mode", e.target.value)}>{(["mirror", "staged_flip", "bottom_flip"] as const).map((x) => <option key={x} value={x}>{MODE_TR[x]}</option>)}</select></label>
          <label className="field">Flip eşiği (%)<input type="number" min={1} max={90} step="0.5" value={manual.flipThresholdPct} onChange={(e) => m("flipThresholdPct", Number(e.target.value))} /></label>
          <label className="field">Take profit (%)<input type="number" min={0} placeholder="kapalı" value={str(manual.takeProfitPct)} onChange={(e) => m("takeProfitPct", num(e.target.value))} /></label>
          <label className="field">Stop loss (%)<input type="number" min={0} placeholder="kapalı" value={str(manual.stopLossPct)} onChange={(e) => m("stopLossPct", num(e.target.value))} /></label>
          <label className="field">Trailing stop (%)<input type="number" min={0} placeholder="kapalı" value={str(manual.trailingStopPct)} onChange={(e) => m("trailingStopPct", num(e.target.value))} /></label>
          <label className="field">Auto-compound (dk)<input type="number" min={5} placeholder="kapalı" value={str(manual.compoundMinutes)} onChange={(e) => m("compoundMinutes", num(e.target.value))} /></label>
        </div>
        <div><button className="btn btn-primary" onClick={saveManual}>Kaydet</button></div>
      </section>

      <p className="muted small">Giriş cüzdanı: <span className="mono">{short(me.user.loginWallet, 8)}</span> · Bot cüzdanından ayrıdır, sadece mesaj imzalar.</p>
    </main>
  );
}
