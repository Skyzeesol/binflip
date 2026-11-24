"use client";

import { useEffect, useState } from "react";
import { api, patch, post } from "@/lib/api";
import { MODE_TR } from "@/lib/format";
import type { CopySettings, Leader, ManagementMode, Strategy } from "@/lib/types";

/** LP Agent's defaults for a new copy, plus ours for step 6. */
export const DEFAULT_SETTINGS: CopySettings = {
  sizing: { mode: "percent_of_leader", percent: 100, fixedSol: null, maxPerTxSol: null, maxPerPositionSol: null },
  exit: { withLeader: true, followExitsWhilePaused: false, takeProfitPct: 10, stopLossPct: 10, trailingStopPct: null, currency: "sol" },
  copy: { dlmmStrategies: ["spot", "curve", "bid_ask", "custom"], dammV2: true },
  protection: { memeProtection: true, smartTokenRetention: false, strHoldSeconds: 60, strSellOnDropPct: 5, strSellOnLeaderSell: true, minTokenAgeHours: null, minMarketCapUsd: null },
  management: { mode: "staged_flip", flipThresholdPct: 10, reshapeBins: 12, compoundMinutes: null, convertFeesToSol: false },
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
  { id: "precision_hybrid", hint: "Fiyat aralığın içinde kaldıkça likiditeyi yeni fiyatın etrafına %50 Spot + %50 Bid-Ask olarak yeniden dağıtır (tek işlem, aralık aynı kalır, swap yok). Fiyat aşağıdaki bin sayısı kadar kayınca tetiklenir." },
];

const num = (v: string) => (v.trim() === "" ? null : Number(v));
const str = (v: number | null | undefined) => (v === null || v === undefined ? "" : String(v));

export function CopyDialog({ leader, onClose, onSaved, initialAddress = "" }: { leader: Leader | null; onClose: () => void; onSaved: () => void; initialAddress?: string }) {
  const isNew = !leader;
  const [step, setStep] = useState(0);
  const [address, setAddress] = useState(initialAddress);
  const [label, setLabel] = useState(leader?.label ?? "");
  const [s, setS] = useState<CopySettings>(leader?.settings ?? DEFAULT_SETTINGS);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof CopySettings>(k: K, v: Partial<CopySettings[K]>) => setS((p) => ({ ...p, [k]: { ...p[k], ...v } }));

  // LP Agent dialog: suggested % (our net worth ÷ leader's) and the High-frequency warning.
  const [ins, setIns] = useState<Insights | null>(null);
  const target = (leader?.address ?? address).trim();
  useEffect(() => {
    setIns(null);
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(target)) return;
    const t = setTimeout(() => void api<Insights>(`/v1/insights?address=${target}`).then(setIns).catch(() => undefined), 400);
    return () => clearTimeout(t);
  }, [target]);

  const sizeSum =
    s.sizing.mode === "fixed_sol"
      ? `${s.sizing.fixedSol ?? "?"} SOL sabit`
      : `%${s.sizing.percent ?? "—"}${s.sizing.maxPerTxSol ? `, işlem başı en fazla ${s.sizing.maxPerTxSol} SOL` : ", üst sınır yok"}`;
  const exitSum = [s.exit.takeProfitPct ? `TP %${s.exit.takeProfitPct}` : null, s.exit.stopLossPct ? `SL %${s.exit.stopLossPct}` : null, s.exit.trailingStopPct ? `trailing %${s.exit.trailingStopPct}` : null]
    .filter(Boolean)
    .join(" · ") || "Sadece liderle çık";
  const copySum = `DLMM: ${s.copy.dlmmStrategies.length === 4 ? "hepsi" : s.copy.dlmmStrategies.join(", ") || "hiçbiri"}${s.copy.dammV2 ? " · DAMM V2" : ""}`;
  const protSum = [s.protection.memeProtection ? "Meme koruması" : null, s.protection.smartTokenRetention ? `Token tutma ${s.protection.strHoldSeconds} sn` : null].filter(Boolean).join(" · ") || "Kapalı";
  const mgmtSum = `${MODE_TR[s.management.mode]}${s.management.mode === "staged_flip" ? ` %${s.management.flipThresholdPct}` : s.management.mode === "precision_hybrid" ? ` ${s.management.reshapeBins ?? 12} bin` : ""}${s.management.compoundMinutes ? ` · compound ${s.management.compoundMinutes} dk` : ""}`;

  const steps = [
    { title: "Sizing", sum: sizeSum },
    { title: "Exit Rules", sum: exitSum },
    { title: "What to Copy", sum: copySum },
    { title: "Protection", sum: protSum },
    { title: "Label", sum: isNew ? label || "—" : label },
    { title: "Management", sum: mgmtSum, ours: true },
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
          <h2>{isNew ? "Copy a new wallet" : `${leader.label} — copy settings`}</h2>
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
                <div><h3>Sizing</h3><p className="muted">Liderin her pozisyonunun ne kadarını kopyalayacağınız.</p></div>
                <div className="row">
                  <label className="check"><input type="radio" checked={s.sizing.mode === "percent_of_leader"} onChange={() => set("sizing", { mode: "percent_of_leader" })} /><span>Copy % of leader<div className="hint">Her pozisyon bu oranda ölçeklenir.</div></span></label>
                  <label className="check"><input type="radio" checked={s.sizing.mode === "fixed_sol"} onChange={() => set("sizing", { mode: "fixed_sol" })} /><span>Fixed SOL<div className="hint">Her yeni pozisyon aynı tutarla açılır.</div></span></label>
                </div>
                {ins?.highFrequency && (
                  <div className="banner banner-warn" style={{ margin: 0, display: "block" }}>
                    <b>Yüksek frekans:</b> bu cüzdan pozisyonlarını ortalama {ins.avgHoldMinutes?.toFixed(0)} dakika tutuyor. Her flip'te giriş swap'ı, çıkış swap'ı ve ağ ücreti ödersiniz.
                    {ins.reAdd1mPct !== null && ins.reAdd1mPct >= 20 && (
                      <> Çıkışlarının %{ins.reAdd1mPct.toFixed(0)}'inde aynı token'ı 1 dakika içinde geri ekliyor. <button className="btn btn-sm" onClick={() => set("protection", { smartTokenRetention: true })}>Smart Token Retention'ı aç</button></>
                    )}
                  </div>
                )}
                {s.sizing.mode === "percent_of_leader" ? (
                  <label className="field">Copy %<input type="number" min={1} max={10000} value={str(s.sizing.percent)} onChange={(e) => set("sizing", { percent: num(e.target.value) })} /><span className="hint">1–10000. {ins?.suggestedPct != null ? <>Önerilen: <b>%{ins.suggestedPct.toFixed(2)}</b> (sizin {ins.ourNetWorthSol?.toFixed(2)} SOL ÷ liderin {ins.leaderNetWorthSol?.toFixed(2)} SOL) <button className="btn btn-sm" onClick={() => set("sizing", { percent: Math.max(1, Math.round(ins.suggestedPct! * 100) / 100) })}>Uygula</button></> : "Önerilen: sizin net varlığınız ÷ liderin net varlığı."}{ins?.suggestedPct != null && ins.suggestedPct <= 1 ? " Lider sizden çok büyük: işlem başı üst sınır koymanız önerilir." : ""}</span></label>
                ) : (
                  <label className="field">SOL per position<input type="number" min={0} step="0.01" value={str(s.sizing.fixedSol)} onChange={(e) => set("sizing", { fixedSol: num(e.target.value) })} /></label>
                )}
                <div className="row">
                  <label className="field">Max Increase Amount per Tx (SOL)<input type="number" min={0} step="0.01" placeholder="sınırsız" value={str(s.sizing.maxPerTxSol)} onChange={(e) => set("sizing", { maxPerTxSol: num(e.target.value) })} /><span className="hint">Her açma ve eklemede üst sınır. Boş = sınırsız. Açılış kısılırsa sonraki eklemeler aynı küçük oranla yapılır (30 gün).</span></label>
                  <label className="field">Max per position (SOL)<input type="number" min={0} step="0.01" placeholder="sınırsız" value={str(s.sizing.maxPerPositionSol)} onChange={(e) => set("sizing", { maxPerPositionSol: num(e.target.value) })} /><span className="hint">Bir pozisyona toplam yatırılabilecek tutar.</span></label>
                </div>
              </div>
            )}

            {step === 1 && (
              <div className="stack">
                <div><h3>Exit Rules</h3><p className="muted">Kopya, lider kapatmadan önce kendi kendine ne zaman kapanır. Hangisi önce gelirse.</p></div>
                <label className="check"><input type="checkbox" checked={s.exit.withLeader} onChange={(e) => set("exit", { withLeader: e.target.checked })} /><span>Exit with leader<div className="hint">Lider kapatınca kopya da kapanır.</div></span></label>
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
                <div><h3>What to Copy</h3><p className="muted">İşaretlenmeyen tipteki lider pozisyonları atlanır.</p></div>
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
                <div><h3>Protection</h3><p className="muted">Bu liderin işlemlerinde botun ne yapacağını değiştiren korumalar.</p></div>
                <label className="check"><input type="checkbox" checked={s.protection.memeProtection} onChange={(e) => set("protection", { memeProtection: e.target.checked })} /><span>Meme Protection<div className="hint">Yatırımın %95'ten fazlası SOL/USDC/USDT dışı token'daysa açma/ekleme atlanır.</div></span></label>
                <label className="check"><input type="checkbox" checked={s.protection.smartTokenRetention} onChange={(e) => set("protection", { smartTokenRetention: e.target.checked })} /><span>Smart Token Retention<div className="hint">Lider çekip kısa sürede aynı token'ı geri eklerse, kopya token'ı satmak yerine bir süre tutar ve geri eklemede kullanır (bir satış + bir alım tasarrufu). Tutulan token'ın fiyatı düşebilir; sadece sık geri ekleme yapan liderlerde açın.{ins?.exitSample ? ` Bu cüzdan, çıkışlarının %${ins.reAdd1mPct?.toFixed(0)}'inde 1 dk, %${ins.reAdd5mPct?.toFixed(0)}'inde 5 dk içinde geri ekliyor (${ins.exitSample} çıkış).` : ""}</div></span></label>
                {s.protection.smartTokenRetention && (
                  <div className="row">
                    <label className="field">Hold for<select value={s.protection.strHoldSeconds} onChange={(e) => set("protection", { strHoldSeconds: Number(e.target.value) })}>{[30, 60, 120, 300].map((v) => <option key={v} value={v}>{v < 60 ? `${v} sn` : `${v / 60} dk`}</option>)}</select></label>
                    <label className="field">Fiyat şu kadar düşerse hemen sat (%)<input type="number" min={0.5} max={50} step="0.5" value={s.protection.strSellOnDropPct} onChange={(e) => set("protection", { strSellOnDropPct: Number(e.target.value) })} /></label>
                  </div>
                )}
              </div>
            )}

            {step === 4 && (
              <div className="stack">
                <div><h3>Label</h3><p className="muted">Listelerde ve kayıtlarda bu cüzdanın adı.</p></div>
                {isNew && <label className="field">Leader wallet address<input type="text" className="mono" placeholder="ör. zbmg9d5x…" value={address} onChange={(e) => setAddress(e.target.value)} /><span className="hint">Sadece kopyalamaya başladıktan sonra açılan pozisyonlar kopyalanır.</span></label>}
                <label className="field">Label<input type="text" maxLength={60} placeholder="ör. Disiplinli Karınca" value={label} onChange={(e) => setLabel(e.target.value)} /></label>
              </div>
            )}

            {step === 5 && (
              <div className="stack">
                <div><h3>Management</h3><p className="muted">Bizim farkımız: kopyalanan pozisyonu kendi kurallarımızla yönetmek.</p></div>
                {MODES.map((m) => (
                  <label key={m.id} className="check">
                    <input type="radio" checked={s.management.mode === m.id} onChange={() => set("management", { mode: m.id })} />
                    <span>{MODE_TR[m.id]}<div className="hint">{m.hint}</div></span>
                  </label>
                ))}
                {s.management.mode === "staged_flip" && (
                  <label className="field">Flip threshold (%)<input type="number" min={1} max={90} step="0.5" value={s.management.flipThresholdPct} onChange={(e) => set("management", { flipThresholdPct: Number(e.target.value) })} /><span className="hint">Varsayılan %10. Bin step 100'de %10 ≈ 11 bin, bin step 20'de ≈ 53 bin.</span></label>
                )}
                {s.management.mode === "precision_hybrid" && (
                  <label className="field">Reshape bins<input type="number" min={1} max={51} step={1} value={s.management.reshapeBins ?? 12} onChange={(e) => set("management", { reshapeBins: Math.min(51, Math.max(1, Math.round(Number(e.target.value) || 12))) })} /><span className="hint">1–51, varsayılan 12. Küçük değer fiyatı daha sıkı takip eder ama daha çok işlem ücreti demek. Aralık 160 bin'den genişse reshape yapılmaz (tek işleme sığmaz).</span></label>
                )}
                <label className="field">Auto-compound (min)<input type="number" min={5} placeholder="kapalı" value={str(s.management.compoundMinutes)} onChange={(e) => set("management", { compoundMinutes: num(e.target.value) })} /><span className="hint">Bu aralıkla, fee'ler en az 0,02 SOL ettiğinde claim edilip pozisyona geri eklenir.</span></label>
              </div>
            )}
          </div>
        </div>

        <div className="dialog-foot">
          {error && <span className="neg small">{error}</span>}
          <div className="spacer" />
          {step > 0 && <button className="btn" onClick={() => setStep(step - 1)}>Back</button>}
          {step < steps.length - 1 && <button className="btn" onClick={() => setStep(step + 1)}>Next</button>}
          <button className="btn btn-primary" onClick={save} disabled={saving || (isNew && (!address.trim() || !label.trim()))}>
            {saving ? "Kaydediliyor…" : isNew ? "Copy" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

interface Insights {
  leaderNetWorthSol: number | null;
  ourNetWorthSol: number | null;
  suggestedPct: number | null;
  avgHoldMinutes: number | null;
  closedSample: number;
  reAdd1mPct: number | null;
  reAdd5mPct: number | null;
  exitSample: number;
  highFrequency: boolean;
}
