"use client";

import { useState } from "react";
import { patch, post } from "@/lib/api";
import { MODE_TR } from "@/lib/format";
import type { CopySettings, Leader, ManagementMode, Strategy } from "@/lib/types";

/** LP Agent's defaults for a new copy, plus ours for step 6. */
export const DEFAULT_SETTINGS: CopySettings = {
  sizing: { mode: "percent_of_leader", percent: 100, fixedSol: null, maxPerTxSol: null, maxPerPositionSol: null },
  exit: { withLeader: true, followExitsWhilePaused: false, takeProfitPct: 10, stopLossPct: 10, trailingStopPct: null, currency: "sol" },
  copy: { dlmmStrategies: ["spot", "curve", "bid_ask", "custom"], dammV2: true },
  protection: { memeProtection: true, smartTokenRetention: false, strHoldSeconds: 60, strSellOnDropPct: 5, strSellOnLeaderSell: true, minTokenAgeHours: null, minMarketCapUsd: null },
  management: { mode: "staged_flip", flipThresholdPct: 10, compoundMinutes: null, convertFeesToSol: false },
};

const STRATS: Array<{ id: Strategy; label: string; hint: string }> = [
  { id: "spot", label: "Spot", hint: "eşit dağılım" },
  { id: "curve", label: "Curve", hint: "fiyatın yakınında yoğun" },
  { id: "bid_ask", label: "BidAsk", hint: "kenarlarda yoğun" },
  { id: "custom", label: "Custom", hint: "diğer şekiller" },
];

const MODES: Array<{ id: ManagementMode; hint: string }> = [
  { id: "mirror", hint: "Liderin yaptığını aynen yap, kendi kuralımız yok (TP/SL hariç)." },
  { id: "staged_flip", hint: "Fiyat eşik kadar düşünce token'a dönmüş bin'leri fiyatın üstüne taşı. Aşağıdaki SOL'e dokunma." },
  { id: "bottom_flip", hint: "Aralığın altına çıkınca (hepsi token) tamamını fiyatın üstüne bid-ask olarak koy." },
  { id: "precision_hybrid", hint: "%50 Spot + %50 Bid-Ask, reshape ile (6. aşama, henüz uygulanmıyor)." },
];

const num = (v: string) => (v.trim() === "" ? null : Number(v));
const str = (v: number | null | undefined) => (v === null || v === undefined ? "" : String(v));

export function CopyDialog({ leader, onClose, onSaved }: { leader: Leader | null; onClose: () => void; onSaved: () => void }) {
  const isNew = !leader;
  const [step, setStep] = useState(0);
  const [address, setAddress] = useState("");
  const [label, setLabel] = useState(leader?.label ?? "");
  const [s, setS] = useState<CopySettings>(leader?.settings ?? DEFAULT_SETTINGS);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof CopySettings>(k: K, v: Partial<CopySettings[K]>) => setS((p) => ({ ...p, [k]: { ...p[k], ...v } }));

  const sizeSum =
    s.sizing.mode === "fixed_sol"
      ? `${s.sizing.fixedSol ?? "?"} SOL sabit`
      : `%${s.sizing.percent ?? "—"}${s.sizing.maxPerTxSol ? `, işlem başı en fazla ${s.sizing.maxPerTxSol} SOL` : ", üst sınır yok"}`;
  const exitSum = [s.exit.takeProfitPct ? `TP %${s.exit.takeProfitPct}` : null, s.exit.stopLossPct ? `SL %${s.exit.stopLossPct}` : null, s.exit.trailingStopPct ? `trailing %${s.exit.trailingStopPct}` : null]
    .filter(Boolean)
    .join(" · ") || "Sadece liderle çık";
  const copySum = `DLMM: ${s.copy.dlmmStrategies.length === 4 ? "hepsi" : s.copy.dlmmStrategies.join(", ") || "hiçbiri"}${s.copy.dammV2 ? " · DAMM V2" : ""}`;
  const protSum = [s.protection.memeProtection ? "Meme koruması" : null, s.protection.smartTokenRetention ? `Token tutma ${s.protection.strHoldSeconds} sn` : null].filter(Boolean).join(" · ") || "Kapalı";
  const mgmtSum = `${MODE_TR[s.management.mode]}${s.management.mode === "staged_flip" ? ` %${s.management.flipThresholdPct}` : ""}${s.management.compoundMinutes ? ` · compound ${s.management.compoundMinutes} dk` : ""}`;

  const steps = [
    { title: "Boyut", sum: sizeSum },
    { title: "Çıkış kuralları", sum: exitSum },
    { title: "Ne kopyalanacak", sum: copySum },
    { title: "Koruma", sum: protSum },
    { title: "Etiket", sum: isNew ? label || "—" : label },
    { title: "Pozisyon yönetimi", sum: mgmtSum, ours: true },
  ];

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      if (s.sizing.mode === "percent_of_leader" && s.sizing.percent === null && s.sizing.maxPerTxSol === null) throw new Error("Kopya yüzdesi, işlem başı üst sınır ya da ikisi birden gerekli.");
      if (isNew) await post("/v1/leaders", { address: address.trim(), label: label.trim(), settings: s });
      else await patch(`/v1/leaders/${leader.id}`, { ...s, label: label.trim() || undefined });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="dialog-head">
          <h2>{isNew ? "Yeni cüzdan kopyala" : `${leader.label} — kopya ayarları`}</h2>
          <div className="spacer" />
          <button className="btn btn-sm btn-ghost" onClick={onClose} aria-label="Kapat">✕</button>
        </div>

        <div className="dialog-body">
          <div className="steps">
            {steps.map((st, i) => (
              <button key={st.title} className={`step ${i === step ? "active" : ""} ${st.ours ? "ours" : ""}`} onClick={() => setStep(i)}>
                <span className="step-title"><span className="step-num">{i + 1}</span>{st.title}</span>
                <span className="step-sum">{st.sum}</span>
              </button>
            ))}
            <div className="note" style={{ margin: 10 }}>Kopyalamak için en az <b>5 SOL</b> net varlık önerilir: her kopya swap ve ağ ücreti öder.</div>
          </div>

          <div className="step-panel">
            {step === 0 && (
              <div className="stack">
                <div><h3>Boyut</h3><p className="muted">Liderin her pozisyonunun ne kadarını kopyalayacağınız.</p></div>
                <div className="row">
                  <label className="check"><input type="radio" checked={s.sizing.mode === "percent_of_leader"} onChange={() => set("sizing", { mode: "percent_of_leader" })} /><span>Liderin yüzdesi<div className="hint">Her pozisyon bu oranda ölçeklenir.</div></span></label>
                  <label className="check"><input type="radio" checked={s.sizing.mode === "fixed_sol"} onChange={() => set("sizing", { mode: "fixed_sol" })} /><span>Sabit SOL<div className="hint">Her yeni pozisyon aynı tutarla açılır.</div></span></label>
                </div>
                {s.sizing.mode === "percent_of_leader" ? (
                  <label className="field">Kopya yüzdesi (%)<input type="number" min={1} max={10000} value={str(s.sizing.percent)} onChange={(e) => set("sizing", { percent: num(e.target.value) })} /><span className="hint">1–10000. Önerilen: sizin net varlığınız ÷ liderin net varlığı (ör. 16,48 / 134,62 → %12).</span></label>
                ) : (
                  <label className="field">Pozisyon başına SOL<input type="number" min={0} step="0.01" value={str(s.sizing.fixedSol)} onChange={(e) => set("sizing", { fixedSol: num(e.target.value) })} /></label>
                )}
                <div className="row">
                  <label className="field">İşlem başı en fazla (SOL)<input type="number" min={0} step="0.01" placeholder="sınırsız" value={str(s.sizing.maxPerTxSol)} onChange={(e) => set("sizing", { maxPerTxSol: num(e.target.value) })} /><span className="hint">Her açma ve eklemede üst sınır. Boş = sınırsız. Açılış kısılırsa sonraki eklemeler aynı küçük oranla yapılır (30 gün).</span></label>
                  <label className="field">Pozisyon başına en fazla (SOL)<input type="number" min={0} step="0.01" placeholder="sınırsız" value={str(s.sizing.maxPerPositionSol)} onChange={(e) => set("sizing", { maxPerPositionSol: num(e.target.value) })} /><span className="hint">Bir pozisyona toplam yatırılabilecek tutar.</span></label>
                </div>
              </div>
            )}

            {step === 1 && (
              <div className="stack">
                <div><h3>Çıkış kuralları</h3><p className="muted">Kopya, lider kapatmadan önce kendi kendine ne zaman kapanır. Hangisi önce gelirse.</p></div>
                <label className="check"><input type="checkbox" checked={s.exit.withLeader} onChange={(e) => set("exit", { withLeader: e.target.checked })} /><span>Liderle çık<div className="hint">Lider kapatınca kopya da kapanır.</div></span></label>
                <label className="check"><input type="checkbox" checked={s.exit.followExitsWhilePaused} onChange={(e) => set("exit", { followExitsWhilePaused: e.target.checked })} /><span>Duraklatılmışken de çıkışları takip et<div className="hint">Kapalıyken (LP Agent gibi) duraklatılan cüzdandan kapanışlar dahil hiçbir şey kopyalanmaz; açık kopyalar kendi TP/SL'leriyle kalır.</div></span></label>
                <div className="row">
                  <label className="field">Take profit (%)<input type="number" min={0} step="0.5" placeholder="kapalı" value={str(s.exit.takeProfitPct)} onChange={(e) => set("exit", { takeProfitPct: num(e.target.value) })} /></label>
                  <label className="field">Stop loss (%)<input type="number" min={0} step="0.5" placeholder="kapalı" value={str(s.exit.stopLossPct)} onChange={(e) => set("exit", { stopLossPct: num(e.target.value) })} /><span className="hint">%15 civarı yaygın bir başlangıç. Çok sıkı tutmak her dalgalanmada çıkış ücreti ödetir. TP/SL açılışta kopyaya yazılır; sonradan değiştirmek açık kopyaları etkilemez.</span></label>
                </div>
                <label className="field">Trailing stop (%)<input type="number" min={0} step="0.5" placeholder="kapalı" value={str(s.exit.trailingStopPct)} onChange={(e) => set("exit", { trailingStopPct: num(e.target.value) })} /><span className="hint">Pozisyon bir kez kâra geçtikten sonra, zirvesinden bu kadar düşerse kapanır.</span></label>
              </div>
            )}

            {step === 2 && (
              <div className="stack">
                <div><h3>Ne kopyalanacak</h3><p className="muted">İşaretlenmeyen tipteki lider pozisyonları atlanır.</p></div>
                <div className="row">
                  {STRATS.map((x) => (
                    <label key={x.id} className="check">
                      <input type="checkbox" checked={s.copy.dlmmStrategies.includes(x.id)} onChange={(e) => set("copy", { dlmmStrategies: e.target.checked ? [...s.copy.dlmmStrategies, x.id] : s.copy.dlmmStrategies.filter((y) => y !== x.id) })} />
                      <span>DLMM {x.label}<div className="hint">{x.hint}</div></span>
                    </label>
                  ))}
                </div>
                <label className="check"><input type="checkbox" checked={s.copy.dammV2} onChange={(e) => set("copy", { dammV2: e.target.checked })} /><span>DAMM V2<div className="hint">Deneme modunda izlenir. Canlı DAMM V2 kopyası henüz yok.</div></span></label>
              </div>
            )}

            {step === 3 && (
              <div className="stack">
                <div><h3>Koruma</h3><p className="muted">Bu liderin işlemlerinde botun ne yapacağını değiştiren korumalar.</p></div>
                <label className="check"><input type="checkbox" checked={s.protection.memeProtection} onChange={(e) => set("protection", { memeProtection: e.target.checked })} /><span>Meme koruması<div className="hint">Yatırımın %95'ten fazlası SOL/USDC/USDT dışı token'daysa açma/ekleme atlanır.</div></span></label>
                <label className="check"><input type="checkbox" checked={s.protection.smartTokenRetention} onChange={(e) => set("protection", { smartTokenRetention: e.target.checked })} /><span>Smart Token Retention <span className="badge">yakında</span><div className="hint">Lider çekip hemen geri eklerse token'ı satmayıp tutar. Ayar kaydedilir, davranış sonraki sürümde.</div></span></label>
                {s.protection.smartTokenRetention && (
                  <div className="row">
                    <label className="field">Tutma süresi<select value={s.protection.strHoldSeconds} onChange={(e) => set("protection", { strHoldSeconds: Number(e.target.value) })}>{[30, 60, 120, 300].map((v) => <option key={v} value={v}>{v < 60 ? `${v} sn` : `${v / 60} dk`}</option>)}</select></label>
                    <label className="field">Fiyat şu kadar düşerse hemen sat (%)<input type="number" min={0.5} max={50} step="0.5" value={s.protection.strSellOnDropPct} onChange={(e) => set("protection", { strSellOnDropPct: Number(e.target.value) })} /></label>
                  </div>
                )}
              </div>
            )}

            {step === 4 && (
              <div className="stack">
                <div><h3>Etiket</h3><p className="muted">Listelerde ve kayıtlarda bu cüzdanın adı.</p></div>
                {isNew && <label className="field">Lider cüzdan adresi<input type="text" className="mono" placeholder="ör. zbmg9d5x…" value={address} onChange={(e) => setAddress(e.target.value)} /><span className="hint">Sadece kopyalamaya başladıktan sonra açılan pozisyonlar kopyalanır.</span></label>}
                <label className="field">Etiket<input type="text" maxLength={60} placeholder="ör. Disiplinli Karınca" value={label} onChange={(e) => setLabel(e.target.value)} /></label>
              </div>
            )}

            {step === 5 && (
              <div className="stack">
                <div><h3>Pozisyon yönetimi</h3><p className="muted">Bizim farkımız: kopyalanan pozisyonu kendi kurallarımızla yönetmek.</p></div>
                {MODES.map((m) => (
                  <label key={m.id} className="check">
                    <input type="radio" checked={s.management.mode === m.id} onChange={() => set("management", { mode: m.id })} disabled={m.id === "precision_hybrid"} />
                    <span>{MODE_TR[m.id]}<div className="hint">{m.hint}</div></span>
                  </label>
                ))}
                {s.management.mode === "staged_flip" && (
                  <label className="field">Flip eşiği (%)<input type="number" min={1} max={90} step="0.5" value={s.management.flipThresholdPct} onChange={(e) => set("management", { flipThresholdPct: Number(e.target.value) })} /><span className="hint">Varsayılan %10. Bin step 100'de %10 ≈ 11 bin, bin step 20'de ≈ 53 bin.</span></label>
                )}
                <label className="field">Auto-compound (dakika)<input type="number" min={5} placeholder="kapalı" value={str(s.management.compoundMinutes)} onChange={(e) => set("management", { compoundMinutes: num(e.target.value) })} /><span className="hint">Bu aralıkla, fee'ler en az 0,02 SOL ettiğinde claim edilip pozisyona geri eklenir.</span></label>
              </div>
            )}
          </div>
        </div>

        <div className="dialog-foot">
          {error && <span className="neg small">{error}</span>}
          <div className="spacer" />
          {step > 0 && <button className="btn" onClick={() => setStep(step - 1)}>Geri</button>}
          {step < steps.length - 1 && <button className="btn" onClick={() => setStep(step + 1)}>İleri</button>}
          <button className="btn btn-primary" onClick={save} disabled={saving || (isNew && (!address.trim() || !label.trim()))}>
            {saving ? "Kaydediliyor…" : isNew ? "Kopyala" : "Kaydet"}
          </button>
        </div>
      </div>
    </div>
  );
}
