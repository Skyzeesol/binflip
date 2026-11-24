"use client";

import { useEffect, useState } from "react";
import { api, post, put } from "@/lib/api";
import type { PfDetail, PfPosition } from "@/lib/types";
import { Amount, Pct, age, tone } from "@/components/Num";
import { reasonTr, short } from "@/lib/format";
import { PairCell, closedAt } from "./Positions";

function Modal({ title, onClose, children, wide = false }: { title: React.ReactNode; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? "modal-wide" : ""}`} role="dialog" aria-modal="true">
        <div className="modal-head">
          <div className="modal-title">{title}</div>
          <button className="btn btn-sm btn-ghost" onClick={onClose} aria-label="Kapat">✕</button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

const KIND_TR: Record<string, string> = { open: "Open", add: "Add", remove: "Decrease", close: "Close", claim: "Claim fees", compound: "Compound", flip: "Flip", swap: "Swap", rebalance: "Rebalance", reshape: "Reshape", withdraw: "Withdraw" };
const STATUS_TR: Record<string, string> = { planned: "planlandı", submitted: "gönderildi", confirmed: "onaylandı", failed: "başarısız", skipped: "atlandı", simulated: "simüle" };

/** LP Agent "Position details": PnL, age, liquidity, fee, price-bin chart, history (CSV) and logs. */
export function PositionDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const [d, setD] = useState<PfDetail | null>(null);
  const [tab, setTab] = useState<"history" | "logs">("history");
  useEffect(() => {
    void api<PfDetail>(`/v1/portfolio/positions/${id}`).then(setD).catch(() => undefined);
  }, [id]);
  const p = d?.position;
  return (
    <Modal title={p ? <PairCell p={p} /> : "Pozisyon"} onClose={onClose} wide>
      {!p ? (
        <div className="empty">Yükleniyor…</div>
      ) : (
        <div className="stack">
          <div className="detail-kpis">
            <div><div className="kpi-label">PnL</div><div className={`kpi-value ${tone(p.pnl)}`}><Amount sol={p.pnl} /></div><div className={`small ${tone(p.pnl)}`}><Pct v={p.pnlPct} /></div></div>
            <div><div className="kpi-label">Age</div><div className="kpi-value">{age(p.ageMs)}</div><div className="small muted">{p.closedAt ? `kapandı ${closedAt(p.closedAt)}` : "açık"}</div></div>
            <div><div className="kpi-label">Liquidity</div><div className="kpi-value"><Amount sol={p.value} /></div><div className="small muted">yatırılan <Amount sol={p.invested} /></div></div>
            <div><div className="kpi-label">Fee</div><div className="kpi-value pos"><Amount sol={p.totalFee} /></div><div className="small muted">claim <Amount sol={p.claimedFee} /> · bekleyen <Amount sol={p.unclaimedFee} /></div></div>
          </div>
          {p.protocol === "dlmm" && <BinChart bins={d.chart.bins} active={d.chart.active} />}
          {p.source === "auto" && (
            <div className="note">
              Kopyalanan lider pozisyonu: {p.leaderLabel ?? "—"} ·{" "}
              {p.leaderPosition ? <a className="mono" href={`https://solscan.io/account/${p.leaderPosition}`} target="_blank" rel="noreferrer">{short(p.leaderPosition, 6)}</a> : "—"}
              {p.closeReason && <> · kapanış nedeni: {reasonTr(p.closeReason)}</>}
            </div>
          )}
          <div className="tabs" style={{ marginBottom: 0 }}>
            <button className={`tab ${tab === "history" ? "active" : ""}`} onClick={() => setTab("history")}>History</button>
            <button className={`tab ${tab === "logs" ? "active" : ""}`} onClick={() => setTab("logs")}>Logs</button>
            <div className="spacer" />
            {tab === "history" && <button className="btn btn-sm" onClick={() => exportCsv(p, d.history)}>Export CSV</button>}
          </div>
          {tab === "history" ? (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Time (UTC)</th><th>Action</th><th>Status</th><th className="num">SOL</th><th>Tx</th></tr></thead>
                <tbody>
                  {d.history.map((h, i) => (
                    <tr key={i}>
                      <td className="muted">{new Date(h.at).toISOString().replace("T", " ").slice(0, 19)}</td>
                      <td>{KIND_TR[h.kind] ?? h.kind}{h.reason ? <div className="small muted">{reasonTr(h.reason)}</div> : null}</td>
                      <td>{STATUS_TR[h.status] ?? h.status}{h.dryRun ? <span className="src src-dry" style={{ marginLeft: 6 }}>dry run</span> : null}</td>
                      <td className={`num ${tone(h.solDelta === null ? null : -h.solDelta)}`}>{h.solDelta === null ? "—" : (-h.solDelta).toFixed(4)}</td>
                      <td>{h.signatures.length ? h.signatures.map((s) => <a key={s} className="mono" href={`https://solscan.io/tx/${s}`} target="_blank" rel="noreferrer">{short(s, 4)} </a>) : <span className="muted">—</span>}</td>
                    </tr>
                  ))}
                  {!d.history.length && <tr><td colSpan={5} className="empty">Kayıt yok.</td></tr>}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="logs">
              {d.logs.map((l, i) => (
                <div key={i} className="log-line">
                  <span className="muted mono">{new Date(l.at).toLocaleString("tr-TR")}</span> {KIND_TR[l.kind] ?? l.kind} · {STATUS_TR[l.status] ?? l.status}
                  {l.reason && <> · {reasonTr(l.reason)}</>}
                  {l.error && <div className="neg small">{l.error}</div>}
                </div>
              ))}
              {!d.logs.length && <div className="empty">Log yok.</div>}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

/** Liquidity per bin (SOL below the price, token above), with the active bin marked. */
function BinChart({ bins, active }: { bins: PfDetail["chart"]["bins"]; active: number | null }) {
  if (!bins.length) return <div className="note">Bin verisi yok (pozisyon henüz okunmadı ya da boş).</div>;
  const sorted = [...bins].sort((a, b) => a.id - b.id);
  const lo = sorted[0]!.id, hi = sorted[sorted.length - 1]!.id;
  const lower = Math.min(lo, active ?? lo), upper = Math.max(hi, active ?? hi);
  const n = upper - lower + 1;
  // Token amounts are in raw units: compare each side to itself, scaled to the same height.
  const maxY = Math.max(1, ...sorted.map((b) => b.y));
  const maxX = Math.max(1, ...sorted.map((b) => b.x));
  const W = 720, H = 140;
  const bw = W / n;
  const by = new Map(sorted.map((b) => [b.id, b]));
  return (
    <div>
      <div className="kpi-label" style={{ marginBottom: 6 }}>Price bins <span className="muted small">(yeşil: SOL, mor: token, sarı: aktif bin)</span></div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Bin grafiği" className="binchart">
        {Array.from({ length: n }, (_, i) => {
          const id = lower + i;
          const b = by.get(id);
          const hy = b ? (b.y / maxY) * (H - 10) : 0;
          const hx = b ? (b.x / maxX) * (H - 10) : 0;
          return (
            <g key={id}>
              {hy > 0 && <rect x={i * bw} y={H - hy} width={Math.max(1, bw - 1)} height={hy} fill="var(--pos)" opacity="0.85"><title>{`bin ${id}: ${(b!.y / 1e9).toFixed(4)} SOL`}</title></rect>}
              {hx > 0 && <rect x={i * bw} y={H - hx} width={Math.max(1, bw - 1)} height={hx} fill="var(--manual)" opacity="0.8"><title>{`bin ${id}: token`}</title></rect>}
            </g>
          );
        })}
        {active !== null && <rect x={(active - lower) * bw} y={0} width={Math.max(2, bw)} height={H} fill="#f5c542" opacity="0.9" />}
      </svg>
      <div className="small muted" style={{ display: "flex", justifyContent: "space-between" }}><span>bin {lower}</span><span>aktif {active ?? "—"}</span><span>bin {upper}</span></div>
    </div>
  );
}

function exportCsv(p: PfPosition, rows: PfDetail["history"]) {
  const head = ["time_utc", "tx_hash", "action", "status", "reason", "sol_change", "network_fee_lamports", "dry_run"];
  const lines = rows.flatMap((h) => {
    const sigs = h.signatures.length ? h.signatures : [""];
    return sigs.map((s) => [new Date(h.at).toISOString(), s, h.kind, h.status, h.reason ?? "", h.solDelta === null ? "" : String(-h.solDelta), h.feeLamports ?? "", h.dryRun].join(","));
  });
  const blob = new Blob([[head.join(","), ...lines].join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `binflip-${p.token?.symbol ?? "position"}-${p.id.slice(0, 8)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ── Manage Positions ────────────────────────────────────────────────────

export type ActionKind = "close" | "decrease" | "claim" | "compound";

export function ActionDialog({ p, kind, onClose, onDone }: { p: PfPosition; kind: ActionKind; onClose: () => void; onDone: (msg: string) => void }) {
  const [pct, setPct] = useState(100);
  const [swapToSol, setSwapToSol] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const title = kind === "close" ? "Zap out (to SOL)" : kind === "decrease" ? "Decrease" : kind === "claim" ? "Claim fees" : "Compound";
  const estPnl = p.pnl;
  const go = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await post<{ dryRun?: boolean; queued?: boolean }>(`/v1/portfolio/positions/${p.id}/action`, { kind, pct: kind === "decrease" ? pct : undefined, swapToSol });
      onDone(r.dryRun ? "Deneme modu: işlem kaydedildi, zincire bir şey gönderilmedi." : "İşlem kuyruğa alındı. Sonucu Telegram'dan ve bu sayfadan takip edebilirsin.");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={title} onClose={onClose}>
      <div className="stack">
        <PairCell p={p} />
        {kind === "close" && (
          <div className="note">
            Pozisyonun tamamı çekilir ve kapanır, çıkan token SOL'e satılır (satılana kadar tekrar denenir). Pozisyon rent'i geri gelir.
            <div style={{ marginTop: 8 }}>Kapanıştan sonra tahmini PnL: <b className={tone(estPnl)}><Amount sol={estPnl} /></b> (<Pct v={p.pnlPct} className={tone(estPnl)} />). Son tutar fiyat ve slippage ile biraz değişebilir.</div>
          </div>
        )}
        {kind === "decrease" && (
          <>
            <label className="field">Çekilecek oran: %{pct}
              <input type="range" min={1} max={100} value={pct} onChange={(e) => setPct(Number(e.target.value))} />
            </label>
            <div className="seg full">
              {[25, 50, 75, 100].map((v) => <button key={v} className={pct === v ? "on" : ""} onClick={() => setPct(v)}>%{v}</button>)}
            </div>
            <div className="note">Yaklaşık <Amount sol={p.value === null ? null : (p.value * pct) / 100} /> çekilir; çıkan token SOL'e satılır. %100 pozisyonu kapatır.</div>
          </>
        )}
        {kind === "claim" && (
          <>
            <div className="note">Bekleyen fee: <b className="pos"><Amount sol={p.unclaimedFee} /></b>. Pozisyona dokunulmaz.</div>
            <label className="check"><input type="checkbox" checked={swapToSol} onChange={(e) => setSwapToSol(e.target.checked)} /> <span>Claim edilen token fee'lerini SOL'e çevir</span></label>
          </>
        )}
        {kind === "compound" && <div className="note">Bekleyen fee'ler claim edilip aynı pozisyona geri eklenir (SOL fiyatın altına, token fiyatın üstüne).</div>}
        {p.dryRun && <div className="banner banner-warn" style={{ margin: 0 }}>Deneme pozisyonu: zincire işlem gönderilmez, sadece kaydedilir.</div>}
        {err && <div className="neg small">{err}</div>}
        <div className="pop-foot">
          <button className="btn" onClick={onClose}>Vazgeç</button>
          <button className={`btn ${kind === "close" || (kind === "decrease" && pct === 100) ? "btn-danger on" : "btn-primary"}`} onClick={go} disabled={busy}>
            {busy ? "Gönderiliyor…" : kind === "close" ? "Zap out" : kind === "decrease" ? `Decrease ${pct}%` : kind === "claim" ? (swapToSol ? "Claim as SOL" : "Claim fees") : "Compound"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Take profit / stop loss (+ our trailing stop) on one position. */
export function ExitsDialog({ p, onClose, onDone }: { p: PfPosition; onClose: () => void; onDone: (msg: string) => void }) {
  const [tp, setTp] = useState(p.exits.takeProfitPct?.toString() ?? "");
  const [sl, setSl] = useState(p.exits.stopLossPct?.toString() ?? "");
  const [tr, setTr] = useState(p.exits.trailingPct?.toString() ?? "");
  const [err, setErr] = useState<string | null>(null);
  const num = (v: string) => (v.trim() === "" ? null : Number(v));
  const save = async () => {
    try {
      await put(`/v1/portfolio/positions/${p.id}/exits`, { takeProfitPct: num(tp), stopLossPct: num(sl), trailingPct: num(tr) });
      onDone("Çıkış kuralları kaydedildi.");
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <Modal title="Take profit / Stop loss" onClose={onClose}>
      <div className="stack">
        <PairCell p={p} />
        <div className="row">
          <label className="field">Take profit (%)<input type="number" min={0.1} placeholder="kapalı" value={tp} onChange={(e) => setTp(e.target.value)} /></label>
          <label className="field">Stop loss (%)<input type="number" min={0.1} placeholder="kapalı" value={sl} onChange={(e) => setSl(e.target.value)} /></label>
        </div>
        <label className="field">Trailing stop (%) <span className="hint">Binflip eklentisi: pozisyon kâra geçtikten sonra zirveden bu kadar düşerse kapatır.</span>
          <input type="number" min={0.1} placeholder="kapalı" value={tr} onChange={(e) => setTr(e.target.value)} />
        </label>
        <div className="note">Boş bırakılan kural kapalıdır. Bu ayar sadece bu pozisyonu etkiler; kopya ayarlarındaki varsayılanlar değişmez.</div>
        {err && <div className="neg small">{err}</div>}
        <div className="pop-foot">
          <button className="btn" onClick={onClose}>Vazgeç</button>
          <button className="btn btn-primary" onClick={save}>Kaydet</button>
        </div>
      </div>
    </Modal>
  );
}
