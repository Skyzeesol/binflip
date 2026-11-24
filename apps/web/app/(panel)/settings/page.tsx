"use client";

import { useEffect, useState } from "react";
import { api, patch, post, put } from "@/lib/api";
import { MODE_TR, short } from "@/lib/format";
import { setSounds, soundsOn } from "@/lib/sound";
import type { Account, ManagementMode, Me, Prefs, Risk } from "@/lib/types";

interface Manual {
  enabled: boolean;
  mode: ManagementMode;
  flipThresholdPct: number;
  reshapeBins: number;
  takeProfitPct: number | null;
  stopLossPct: number | null;
  trailingStopPct: number | null;
  compoundMinutes: number | null;
}

type Tab = "general" | "swap" | "security" | "notify" | "account";
const TABS: Array<{ id: Tab; label: string }> = [
  { id: "general", label: "Genel" },
  { id: "swap", label: "Swap" },
  { id: "security", label: "Güvenlik" },
  { id: "notify", label: "Bildirimler" },
  { id: "account", label: "Hesap" },
];
// Old deep links (#limits, #filters, #wallet) land on the right tab.
const HASH_TAB: Record<string, Tab> = { limits: "general", general: "general", swap: "swap", filters: "security", security: "security", notify: "notify", wallet: "account", account: "account" };

const NOTIFY: Array<{ k: string; label: string; hint: string }> = [
  { k: "copy_open", label: "Kopya açıldı / eklendi", hint: "Lider açınca ya da ekleyince yaptığımız (ya da deneme modunda yapacağımız) işlem." },
  { k: "copy_close", label: "Kopya kapandı / azaldı", hint: "Liderle çıkışlar." },
  { k: "copy_skip", label: "Kopya atlandı", hint: "Ayarlar, filtreler ya da limitler yüzünden açılmayanlar." },
  { k: "copy_fail", label: "Kopya başarısız", hint: "Gönderilemeyen ya da kontrol isteyen işlemler. Açık tutman önerilir." },
  { k: "manage", label: "Yönetim", hint: "Flip, compound, TP/SL/trailing, panelden ve Telegram'dan açılan pozisyonlar." },
  { k: "swap", label: "Token → SOL satışları", hint: "Çıkıştan kalan tokenlerin satışı ve tekrar denemeleri." },
  { k: "sweep", label: "Kâr süpürme / çekim", hint: "Ana cüzdana gönderilen SOL, Claim SOL." },
  { k: "system", label: "Sistem", hint: "Diğer uyarılar." },
];

const num = (v: string) => (v.trim() === "" ? null : Number(v));
const str = (v: number | null | undefined) => (v === null || v === undefined ? "" : String(v));

/** LP Agent Settings: General, Swap, Security, Account (+ Binflip: notifications, limits, own positions). */
export default function SettingsPage() {
  const [tab, setTab] = useState<Tab>("general");
  const [me, setMe] = useState<Me | null>(null);
  const [risk, setRisk] = useState<Risk | null>(null);
  const [manual, setManual] = useState<Manual | null>(null);
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [acc, setAcc] = useState<Account | null>(null);
  const [sounds, setSoundsState] = useState(true);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newToken, setNewToken] = useState("");

  useEffect(() => {
    const h = window.location.hash.replace("#", "");
    if (HASH_TAB[h]) setTab(HASH_TAB[h]);
    setSoundsState(soundsOn());
    void Promise.all([api<Me>("/v1/me"), api<Risk>("/v1/risk"), api<Manual>("/v1/manual"), api<Prefs>("/v1/prefs")]).then(([m, r, mn, p]) => {
      setMe(m);
      setRisk(r);
      setManual(mn);
      setPrefs(p);
    });
    void api<Account>("/v1/account").then(setAcc).catch(() => undefined);
  }, []);

  const flash = (msg: string) => {
    setSaved(msg);
    setError(null);
    setTimeout(() => setSaved(null), 2500);
  };
  const go = (t: Tab) => {
    setTab(t);
    window.history.replaceState(null, "", `#${t}`);
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
      flash("Kaydedildi");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const saveManual = async () => {
    if (!manual) return;
    try {
      await put("/v1/manual", manual);
      flash("Kaydedildi");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const savePrefs = async (p: Prefs) => {
    setPrefs(p);
    try {
      await put("/v1/prefs", p);
      flash("Kaydedildi");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const resume = async () => {
    await post("/v1/fund-protection/resume");
    setRisk(await api<Risk>("/v1/risk"));
    flash("Fon koruması yeniden başladı (aynı limit, sıfır sayaç)");
  };
  const claimSol = async () => {
    try {
      await post("/v1/account/claim-sol");
      flash("Claim SOL kuyruğa alındı; sonucu Telegram'dan gelecek");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!risk || !manual || !me || !prefs) return <main className="page muted">Yükleniyor…</main>;
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
      <div className="tabs" style={{ marginBottom: 0 }}>
        {TABS.map((t) => <button key={t.id} className={`tab ${tab === t.id ? "active" : ""}`} onClick={() => go(t.id)}>{t.label}</button>)}
      </div>

      {tab === "general" && (
        <>
          <section className="card card-pad stack">
            <h3 style={{ margin: 0 }}>Auto TP/SL</h3>
            <label className="check">
              <input type="checkbox" checked={prefs.autoTpSl.enabled} onChange={(e) => void savePrefs({ ...prefs, autoTpSl: { ...prefs.autoTpSl, enabled: e.target.checked } })} />
              <span>Açtığım her yeni pozisyona varsayılan TP/SL koy<div className="hint">Panelden ve Telegram'dan açılan pozisyonlar için. Kopyalar kendi çıkış kurallarını kullanır.</div></span>
            </label>
            <div className="row">
              <label className="field">Take profit (%)<input type="number" min={0.1} value={prefs.autoTpSl.takeProfitPct} onChange={(e) => setPrefs({ ...prefs, autoTpSl: { ...prefs.autoTpSl, takeProfitPct: Number(e.target.value) } })} onBlur={() => void savePrefs(prefs)} /></label>
              <label className="field">Stop loss (%)<input type="number" min={0.1} value={prefs.autoTpSl.stopLossPct} onChange={(e) => setPrefs({ ...prefs, autoTpSl: { ...prefs.autoTpSl, stopLossPct: Number(e.target.value) } })} onBlur={() => void savePrefs(prefs)} /></label>
            </div>
          </section>

          <section className="card card-pad stack">
            <h3 style={{ margin: 0 }}>Kendi açtığım pozisyonlar (Manage Manual Position)</h3>
            <p className="muted small" style={{ margin: 0 }}>Bot cüzdanını Phantom'a ekleyip kendin açtığın pozisyonlar ~5 dakikada bir bulunur ve bu kurallarla yönetilir. PnL, yönetime alındığı andaki değerden ölçülür.</p>
            <label className="check"><input type="checkbox" checked={manual.enabled} onChange={(e) => m("enabled", e.target.checked)} /><span>Kendi pozisyonlarımı yönet</span></label>
            <div className="row">
              <label className="field">Yönetim modu<select value={manual.mode} onChange={(e) => m("mode", e.target.value)}>{(["mirror", "staged_flip", "bottom_flip", "precision_hybrid"] as const).map((x) => <option key={x} value={x}>{MODE_TR[x]}</option>)}</select></label>
              <label className="field">Flip eşiği (%)<input type="number" min={1} max={90} step="0.5" value={manual.flipThresholdPct} onChange={(e) => m("flipThresholdPct", Number(e.target.value))} /></label>
              {manual.mode === "precision_hybrid" && <label className="field">Reshape aralığı (bin)<input type="number" min={1} max={51} value={manual.reshapeBins ?? 12} onChange={(e) => m("reshapeBins", Math.min(51, Math.max(1, Math.round(Number(e.target.value) || 12))))} /></label>}
              <label className="field">Take profit (%)<input type="number" min={0} placeholder="kapalı" value={str(manual.takeProfitPct)} onChange={(e) => m("takeProfitPct", num(e.target.value))} /></label>
              <label className="field">Stop loss (%)<input type="number" min={0} placeholder="kapalı" value={str(manual.stopLossPct)} onChange={(e) => m("stopLossPct", num(e.target.value))} /></label>
              <label className="field">Trailing stop (%)<input type="number" min={0} placeholder="kapalı" value={str(manual.trailingStopPct)} onChange={(e) => m("trailingStopPct", num(e.target.value))} /></label>
              <label className="field">Auto-compound (dk)<input type="number" min={5} placeholder="kapalı" value={str(manual.compoundMinutes)} onChange={(e) => m("compoundMinutes", num(e.target.value))} /></label>
            </div>
            <div><button className="btn btn-primary" onClick={saveManual}>Kaydet</button></div>
          </section>

          <section className="card card-pad stack">
            <h3 style={{ margin: 0 }}>Limitler ve fon koruması</h3>
            {risk.fundProtectionTrippedAt ? (
              <div className="banner banner-neg" style={{ margin: 0 }}>
                Durduruldu: zarar limiti doldu. Yeni kopyalar açılmıyor, çıkışlar liderleri takip ediyor.
                <div className="spacer" />
                <button className="btn btn-sm" onClick={resume}>Devam et</button>
              </div>
            ) : risk.fundProtectionEnabled && risk.fundProtectionLimitSol !== null ? (
              <div className="note">Limit: zirveden {risk.fundProtectionLimitSol.toFixed(4)} SOL kayıp (kaydedildiği günkü net varlığın %{risk.fundProtectionLossPct}'i).</div>
            ) : null}
            <div className="row">
              <label className="field">İşlem başı en fazla (SOL)<input type="number" min={0} step="0.1" value={risk.maxSolPerTx} onChange={(e) => r("maxSolPerTx", Number(e.target.value))} /><span className="hint">Hiçbir açma/ekleme bunu geçemez.</span></label>
              <label className="field">Günlük en fazla (SOL)<input type="number" min={0} step="0.5" value={risk.maxSolPerDay} onChange={(e) => r("maxSolPerDay", Number(e.target.value))} /></label>
            </div>
            <label className="check"><input type="checkbox" checked={risk.fundProtectionEnabled} onChange={(e) => r("fundProtectionEnabled", e.target.checked)} /><span>Fon koruması<div className="hint">Kapanan kopyalardaki zarar, net varlığın bu yüzdesine ulaşınca yeni girişler durur; çıkışlar liderleri takip etmeye devam eder.</div></span></label>
            <label className="field">Zirveden en fazla zarar (%)<input type="number" min={1} max={100} value={risk.fundProtectionLossPct} onChange={(e) => r("fundProtectionLossPct", Number(e.target.value))} /><span className="hint">Kaydetmek sayacı sıfırlar.</span></label>
            <div><button className="btn btn-primary" onClick={saveRisk}>Kaydet</button></div>
          </section>

          <section className="card card-pad stack">
            <h3 style={{ margin: 0 }}>Bu cihaz</h3>
            <label className="check">
              <input type="checkbox" checked={sounds} onChange={(e) => (setSounds(e.target.checked), setSoundsState(e.target.checked))} />
              <span>Pozisyon sesleri<div className="hint">Portfolio açıkken bir pozisyon açılınca ya da kapanınca kısa bir ses çalar. Açınca bir kez çalar.</div></span>
            </label>
          </section>
        </>
      )}

      {tab === "swap" && (
        <section className="card card-pad stack">
          <h3 style={{ margin: 0 }}>Swap</h3>
          <label className="field">Slippage (%)<input type="number" min={0.1} max={50} step="0.1" value={risk.slippagePct} onChange={(e) => r("slippagePct", Number(e.target.value))} /><span className="hint">Botun yaptığı bütün swap'lar için: zap, kopyalar, kapanışlar, token → SOL satışları.{risk.slippagePct > 7 ? " ⚠ %7 üstü yüksek." : ""}</span></label>
          <div className="note">Yöntem: <b>Jupiter</b> (platform ücreti yok). Rota bulunamazsa ya da Jupiter hata verirse aynı Meteora havuzu üzerinden satılır. Kopyalar "fiyat değişti" diye başarısız oluyorsa slippage'ı biraz yükselt; volatil tokenler daha fazla pay ister.</div>
          <div><button className="btn btn-primary" onClick={saveRisk}>Kaydet</button></div>
        </section>
      )}

      {tab === "security" && (
        <section className="card card-pad stack">
          <h3 style={{ margin: 0 }}>Token filtreleri</h3>
          <p className="muted small" style={{ margin: 0 }}>Bir pozisyon açılmadan ya da kopyalanmadan önce uygulanır. Geçemeyen token atlanır; Kopya Kayıtları hangi filtrenin durdurduğunu gösterir.</p>
          <div className="row">
            <label className="field">Jupiter Organic Score (en az)<input type="number" min={0} max={100} value={str(risk.minOrganicScore)} onChange={(e) => r("minOrganicScore", num(e.target.value))} /><span className="hint">Botlar ve sybil'ler hariç gerçek zincir aktivitesi (0–100).</span></label>
            <label className="field">Piyasa değeri (en az, $)<input type="number" min={0} step="10000" value={str(risk.minMarketCapUsd)} onChange={(e) => r("minMarketCapUsd", num(e.target.value))} /></label>
            <label className="field">24s hacim (en az, $)<input type="number" min={0} step="10000" value={str(risk.min24hVolumeUsd)} onChange={(e) => r("min24hVolumeUsd", num(e.target.value))} /></label>
            <label className="field">Holder (en az)<input type="number" min={0} value={str(risk.minHolders)} onChange={(e) => r("minHolders", num(e.target.value))} /><span className="hint">0 = sınır yok.</span></label>
          </div>
          <div className="field">Kara liste ({risk.tokenBlacklist.length})
            <div className="amount-row">
              <input type="text" className="mono" placeholder="Token adresi yapıştır" value={newToken} onChange={(e) => setNewToken(e.target.value)} />
              <button className="btn btn-sm" disabled={!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(newToken.trim())} onClick={() => (r("tokenBlacklist", [...new Set([...risk.tokenBlacklist, newToken.trim()])]), setNewToken(""))}>Ekle</button>
            </div>
            <div className="bl-list">
              {risk.tokenBlacklist.map((t) => (
                <span key={t} className="chip">{short(t, 6)} <button className="btn btn-sm btn-ghost" onClick={() => r("tokenBlacklist", risk.tokenBlacklist.filter((x) => x !== t))} aria-label="Kaldır">✕</button></span>
              ))}
              {!risk.tokenBlacklist.length && <span className="muted small">Kara listede token yok.</span>}
            </div>
          </div>
          <div><button className="btn btn-primary" onClick={saveRisk}>Filtreleri kaydet</button></div>
        </section>
      )}

      {tab === "notify" && (
        <section className="card card-pad stack">
          <h3 style={{ margin: 0 }}>Telegram bildirimleri</h3>
          <p className="muted small" style={{ margin: 0 }}>Kapattığın türler Telegram'a gönderilmez (loglarda yine görünür). Komutlar: /durum, /stop, /devam, /ac &lt;havuz&gt;, /iptal.</p>
          {NOTIFY.map((n) => (
            <label key={n.k} className="check">
              <input type="checkbox" checked={prefs.notify[n.k] !== false} onChange={(e) => void savePrefs({ ...prefs, notify: { ...prefs.notify, [n.k]: e.target.checked } })} />
              <span>{n.label}<div className="hint">{n.hint}</div></span>
            </label>
          ))}
        </section>
      )}

      {tab === "account" && (
        <>
          <section className="card card-pad stack">
            <h3 style={{ margin: 0 }}>Bot cüzdanı</h3>
            {me.agentWallets.length ? (
              me.agentWallets.map((w) => (
                <div key={w.id} style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <span style={{ fontWeight: 600 }}>{w.label}</span>
                  <a className="mono" href={`https://solscan.io/account/${w.publicKey}`} target="_blank" rel="noreferrer">{w.publicKey}</a>
                </div>
              ))
            ) : (
              <p className="muted" style={{ margin: 0 }}>Henüz bot cüzdanı yok. Sunucuda <code>wallet:create</code> ile oluşturulur.</p>
            )}
            <div className="note">
              Mod: <b>{me.mode === "live" ? "CANLI" : "DENEME"}</b>. Canlıya geçiş sadece sunucuda yapılır (<code>docker-compose.live.yml</code>). Özel anahtar panelde hiçbir zaman gösterilmez ya da dışa aktarılmaz; şifreli keystore sadece sunucudadır. Yatırma ve ana cüzdana çekme sağ üstteki hesap menüsünde.
            </div>
          </section>
          <section className="card card-pad stack">
            <h3 style={{ margin: 0 }}>Claim SOL</h3>
            <p className="muted small" style={{ margin: 0 }}>Her token hesabı ~0,002 SOL rent tutar. Boş (bakiyesi 0) olanlar kapatılır, SOL bot cüzdanına geri döner.</p>
            <div className="note">Boş token hesabı: <b>{acc?.emptyAccounts ?? "—"}</b> · geri alınabilir: <b>{acc?.claimableSol !== undefined ? `${acc.claimableSol.toFixed(4)} SOL` : "—"}</b></div>
            <div><button className="btn btn-primary" disabled={!acc?.emptyAccounts} onClick={claimSol}>SOL'ü geri al</button></div>
          </section>
          <section className="card card-pad">
            <div className="small muted">Giriş cüzdanı: <span className="mono">{me.user.loginWallet}</span> · Bot cüzdanından ayrıdır, sadece mesaj imzalar. Rol: {me.user.role}.</div>
          </section>
        </>
      )}
    </main>
  );
}
