"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { CopyDialog } from "@/components/CopyDialog";
import { PnlChart } from "@/components/PnlChart";
import { api, del, post } from "@/lib/api";
import { MODE_TR, ago, reasonTr, short, signed, solFmt, time } from "@/lib/format";
import type { Analysis, Leader, LogRow, Me } from "@/lib/types";

type Tab = "wallets" | "analysis" | "logs";

export default function CopyLpPage() {
  const [tab, setTab] = useState<Tab>("wallets");
  const [leaders, setLeaders] = useState<Leader[]>([]);
  const [editing, setEditing] = useState<Leader | null | undefined>(undefined); // undefined = closed, null = new

  const loadLeaders = useCallback(() => api<Leader[]>("/v1/leaders").then(setLeaders), []);
  useEffect(() => {
    void loadLeaders()
      .then(() => undefined)
      .catch(() => undefined);
  }, [loadLeaders]);
  // Deep link from a "fix" button: /?edit=<leaderId> opens that wallet's copy dialog.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("edit");
    const l = id ? leaders.find((x) => x.id === id) : undefined;
    if (l) {
      setEditing(l);
      window.history.replaceState(null, "", "/copy");
    }
  }, [leaders]);

  return (
    <main className="page">
      <div className="page-head">
        <h1>Copy LP</h1>
        <div className="spacer" />
        <button className="btn btn-primary" onClick={() => setEditing(null)}>+ Cüzdan kopyala</button>
      </div>

      <div className="tabs">
        <button className={`tab ${tab === "wallets" ? "active" : ""}`} onClick={() => setTab("wallets")}>Kopyalanan Cüzdanlar<span className="count">{leaders.length}</span></button>
        <button className={`tab ${tab === "analysis" ? "active" : ""}`} onClick={() => setTab("analysis")}>Analiz</button>
        <button className={`tab ${tab === "logs" ? "active" : ""}`} onClick={() => setTab("logs")}>Kopya Kayıtları</button>
      </div>

      {tab === "wallets" && <Wallets leaders={leaders} reload={loadLeaders} onEdit={setEditing} />}
      {tab === "analysis" && <AnalysisTab leaders={leaders} />}
      {tab === "logs" && <LogsTab leaders={leaders} />}

      {editing !== undefined && (
        <CopyDialog
          leader={editing}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            void loadLeaders();
          }}
        />
      )}
    </main>
  );
}

function Wallets({ leaders, reload, onEdit }: { leaders: Leader[]; reload: () => Promise<void>; onEdit: (l: Leader) => void }) {
  const [agent, setAgent] = useState<{ label: string; publicKey: string } | null>(null);
  useEffect(() => {
    void api<Me>("/v1/me").then((m) => setAgent(m.agentWallets[0] ?? null)).catch(() => undefined);
  }, []);
  const toggle = async (l: Leader) => {
    await post(`/v1/leaders/${l.id}/${l.status === "active" ? "pause" : "resume"}`);
    await reload();
  };
  const remove = async (l: Leader) => {
    if (!confirm(`${l.label} listeden çıkarılsın mı? Açık kopyalar siz kapatana kadar açık kalır.`)) return;
    await del(`/v1/leaders/${l.id}`);
    await reload();
  };
  const active = leaders.filter((l) => l.status === "active");
  const paused = leaders.filter((l) => l.status === "paused");
  const groups = [
    { title: "AKTİF", on: true, rows: active },
    { title: "DURAKLATILDI", on: false, rows: paused },
  ].filter((g) => g.rows.length);

  return (
    <section>
      <div className="cw-head">
        <div>
          <h2>Kopyalanan Cüzdanlar</h2>
          <div className="muted">{active.length} aktif, {paused.length} duraklatılmış</div>
        </div>
        <Link className="link-accent" href="/smart-lp">Smart LP'de yeni cüzdan bul →</Link>
      </div>
      {!leaders.length ? (
        <div className="card empty">Henüz kopyalanan cüzdan yok. Sağ üstten bir lider cüzdan ekleyin ya da Smart LP'den seçin.</div>
      ) : (
        <div className="card table-wrap">
          <table className="cw-table">
            <thead>
              <tr>
                <th>Cüzdan</th>
                <th>Kopya boyutu</th>
                <th>Otomatik çıkış</th>
                <th className="num">Pozisyon</th>
                <th className="num">Son hareket</th>
                <th className="num">PnL</th>
                <th>Kopya</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <Fragment key={g.title}>
                  <tr className="cw-group"><td colSpan={8}><span className="dot" style={{ color: g.on ? "var(--pos)" : "var(--muted)" }} /> {g.title} · {g.rows.length}</td></tr>
                  {g.rows.map((l) => {
                    const z = l.settings;
                    const size = z.sizing.mode === "fixed_sol" ? `Pozisyon başına ${z.sizing.fixedSol} SOL` : `Her pozisyonun %${z.sizing.percent ?? "—"}'i`;
                    const exit = [z.exit.takeProfitPct ? `TP ${z.exit.takeProfitPct}%` : null, z.exit.stopLossPct ? `SL ${z.exit.stopLossPct}%` : null, z.exit.trailingStopPct ? `Trailing ${z.exit.trailingStopPct}%` : null].filter(Boolean).join(" · ");
                    return (
                      <tr key={l.id} className="clickable" onClick={() => onEdit(l)}>
                        <td>
                          <Link href={`/wallet/${l.address}`} className="cw-label" onClick={(e) => e.stopPropagation()}>{l.label}</Link>
                          <div className="mono muted cw-addr">
                            {short(l.address, 6)}
                            <button className="btn btn-sm btn-ghost" onClick={(e) => (e.stopPropagation(), navigator.clipboard.writeText(l.address))} aria-label="Adresi kopyala">⧉</button>
                          </div>
                          {agent && <div className="mono muted small cw-agent">Agent: {agent.label}<br />{agent.publicKey}</div>}
                        </td>
                        <td>
                          {size}
                          {z.sizing.maxPerTxSol ? <div className="small muted">işlem başına en fazla {z.sizing.maxPerTxSol} SOL</div> : null}
                          {z.management.mode !== "mirror" && <div><span className="badge badge-accent">{MODE_TR[z.management.mode]}{z.management.mode === "staged_flip" ? ` %${z.management.flipThresholdPct}` : ""}</span></div>}
                        </td>
                        <td className={exit ? "" : "muted"}>{exit || "Kapalı"}</td>
                        <td className="num">{l.positions || "-"}</td>
                        <td className="num">{ago(l.lastActivity)}</td>
                        <td className={`num ${l.pnlSol >= 0.005 ? "pos" : l.pnlSol <= -0.005 ? "neg" : ""}`}>{Math.abs(l.pnlSol) < 0.005 ? "0.00" : l.pnlSol.toFixed(2)} SOL</td>
                        <td onClick={(e) => e.stopPropagation()}>
                          <button className={`switch ${l.status === "active" ? "on" : ""}`} onClick={() => toggle(l)} aria-label="Kopyalamayı aç/kapat" />
                        </td>
                        <td onClick={(e) => e.stopPropagation()}>
                          <button className="btn btn-sm btn-ghost" onClick={() => remove(l)} title="Kopyalamayı bırak">Bırak</button>
                        </td>
                      </tr>
                    );
                  })}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

const RANGES = [
  { id: "7D", label: "7G" },
  { id: "1M", label: "1A" },
  { id: "3M", label: "3A" },
  { id: "1Y", label: "1Y" },
  { id: "YTD", label: "Yılbaşından" },
  { id: "ALL", label: "Tümü" },
] as const;

function AnalysisTab({ leaders }: { leaders: Leader[] }) {
  const [range, setRange] = useState<(typeof RANGES)[number]["id"]>("1M");
  const [data, setData] = useState<Analysis | null>(null);
  useEffect(() => {
    void api<Analysis>(`/v1/analysis?range=${range}`).then(setData).catch(() => undefined);
  }, [range]);
  const labelOf = (id: string | null) => leaders.find((l) => l.id === id)?.label ?? "manuel";

  return (
    <div className="stack">
      <div style={{ display: "flex", gap: 6 }}>
        {RANGES.map((r) => (
          <button key={r.id} className={`btn btn-sm ${range === r.id ? "btn-primary" : ""}`} onClick={() => setRange(r.id)}>{r.label}</button>
        ))}
      </div>
      {data && (
        <>
          <div className="grid-kpi">
            <div className="card card-pad"><div className="kpi-label">Toplam PnL (tahmini)</div><div className={`kpi-value num ${data.totals.pnlSol >= 0 ? "pos" : "neg"}`}>{signed(data.totals.pnlSol)} SOL</div></div>
            <div className="card card-pad"><div className="kpi-label">Açılan kopya</div><div className="kpi-value num">{data.totals.opened}</div></div>
            <div className="card card-pad"><div className="kpi-label">Ödenen ağ ücreti</div><div className="kpi-value num">{data.totals.networkFeesSol.toFixed(4)} SOL</div></div>
          </div>
          <div className="card card-pad">
            <div className="kpi-label" style={{ marginBottom: 8 }}>Kümülatif PnL, cüzdan bazında</div>
            <PnlChart series={data.series} labelOf={labelOf} />
          </div>
          <div className="card table-wrap">
            <table>
              <thead><tr><th>Cüzdan</th><th className="num">Açılan</th><th className="num">Açık</th><th className="num">Yatırılan</th><th className="num">PnL</th></tr></thead>
              <tbody>
                {data.wallets.map((w) => (
                  <tr key={w.leaderId ?? "manual"}>
                    <td style={{ fontWeight: 600 }}>{w.label}</td>
                    <td className="num">{w.opened}</td>
                    <td className="num">{w.open}</td>
                    <td className="num">{w.depositedSol.toFixed(4)} SOL</td>
                    <td className={`num ${w.pnlSol >= 0 ? "pos" : "neg"}`}>{signed(w.pnlSol)} SOL</td>
                  </tr>
                ))}
                {!data.wallets.length && <tr><td colSpan={5} className="empty">Bu aralıkta pozisyon yok.</td></tr>}
              </tbody>
            </table>
          </div>
          <p className="muted small">PnL, açık pozisyonlarda güncel değerden, kapananlarda son değerden hesaplanır (claim edilmemiş fee'ler dahil). Kopyanız, liderden farklı sonuç verebilir: kendi TP/SL'iniz erken kapatabilir, düşük bakiye yüzünden atlanan kopyalar hiç açılmaz.</p>
        </>
      )}
    </div>
  );
}

const LOG_TABS = [
  { id: "all", label: "Tümü" },
  { id: "not_opened", label: "Açılmayan" },
  { id: "failed", label: "Başarısız" },
  { id: "open", label: "Açık" },
  { id: "closed", label: "Kapalı" },
] as const;

const RESULT_TR: Record<string, { label: string; cls: string }> = {
  Open: { label: "Açık", cls: "badge-accent" },
  Closed: { label: "Kapandı", cls: "" },
  Holding: { label: "Tutuluyor", cls: "badge-dry" },
  NotOpened: { label: "Açılmadı", cls: "badge-dry" },
  Skipped: { label: "Atlandı", cls: "" },
  Failed: { label: "Başarısız", cls: "badge-neg" },
  Pending: { label: "Bekliyor", cls: "badge-dry" },
};

const KIND_TR: Record<string, string> = { open: "Açma", add: "Ekleme", remove: "Çekme", close: "Kapama", claim: "Claim", flip: "Flip", compound: "Compound", swap: "Swap", rebalance: "Rebalance", reshape: "Reshape" };

function LogsTab({ leaders }: { leaders: Leader[] }) {
  const [tab, setTab] = useState<(typeof LOG_TABS)[number]["id"]>("all");
  const [leaderId, setLeaderId] = useState("");
  const [rows, setRows] = useState<LogRow[]>([]);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    void api<LogRow[]>(`/v1/logs?tab=${tab}${leaderId ? `&leaderId=${leaderId}` : ""}`).then(setRows).catch(() => undefined);
  }, [tab, leaderId]);

  // Fold consecutive identical skips, like LP Agent ("3 more not opened, same reason").
  const folded = useMemo(() => {
    const out: Array<LogRow & { more: number }> = [];
    for (const r of rows) {
      const prev = out[out.length - 1];
      if (prev && r.status === "skipped" && prev.status === "skipped" && prev.reason === r.reason && prev.source.label === r.source.label) prev.more++;
      else out.push({ ...r, more: 0 });
    }
    return out;
  }, [rows]);

  return (
    <div className="stack">
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <div className="tabs" style={{ margin: 0, border: 0 }}>
          {LOG_TABS.map((t) => (
            <button key={t.id} className={`tab ${tab === t.id ? "active" : ""}`} onClick={() => setTab(t.id)}>{t.label}</button>
          ))}
        </div>
        <div className="spacer" />
        <select value={leaderId} onChange={(e) => setLeaderId(e.target.value)} style={{ width: 220 }}>
          <option value="">Tüm cüzdanlar</option>
          {leaders.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
        </select>
      </div>
      <div className="card table-wrap">
        <table>
          <thead><tr><th>Zaman</th><th>Kaynak</th><th>İşlem</th><th>Sonuç</th><th>Neden</th><th className="num">SOL</th><th>Havuz</th></tr></thead>
          <tbody>
            {folded.map((r) => (
              <FragmentRow key={r.id} r={r} open={open === r.id} onToggle={() => setOpen(open === r.id ? null : r.id)} />
            ))}
            {!folded.length && <tr><td colSpan={7} className="empty">Son 7 günde kayıt yok.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="muted small">Son 7 gün. Satıra tıklayınca ayrıntı açılır.</p>
    </div>
  );
}

/** LP Agent "Fix it in one click": a button next to the reason that leads to the fix. */
const FIX: Record<string, { label: string; href: (leaderId: string | null) => string }> = {
  low_balance: { label: "Bakiye yükle", href: () => "/settings#wallet" },
  send_failed: { label: "Slippage'ı yükselt", href: () => "/settings#limits" },
  tokens_left_retrying: { label: "Slippage'ı yükselt", href: () => "/settings#limits" },
  fund_protection: { label: "Limiti düzenle", href: () => "/settings#limits" },
  daily_limit: { label: "Limiti düzenle", href: () => "/settings#limits" },
  copy_size_zero: { label: "Kopya boyutunu düzenle", href: (id) => `/copy?edit=${id ?? ""}` },
  position_cap_reached: { label: "Kopya boyutunu düzenle", href: (id) => `/copy?edit=${id ?? ""}` },
  no_sizing_rule: { label: "Kopya boyutunu düzenle", href: (id) => `/copy?edit=${id ?? ""}` },
  meme_protection: { label: "Kopya ayarlarını düzenle", href: (id) => `/copy?edit=${id ?? ""}` },
  strategy_not_copied: { label: "Kopya ayarlarını düzenle", href: (id) => `/copy?edit=${id ?? ""}` },
  pool_type_not_copied: { label: "Kopya ayarlarını düzenle", href: (id) => `/copy?edit=${id ?? ""}` },
  token_filter: { label: "Filtreleri düzenle", href: () => "/settings#filters" },
  token_blacklisted: { label: "Kara listeyi düzenle", href: () => "/settings#filters" },
  kill_switch: { label: "Acil durdurmayı kaldır", href: () => "/settings#limits" },
};

/** LP Agent: kept tokens show as Holding, with a countdown and a Sell now button. */
function HoldCountdown({ row }: { row: LogRow }) {
  const until = (row.plan as { holdUntil?: string }).holdUntil;
  const [now, setNow] = useState(Date.now());
  const [done, setDone] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = until ? Math.max(0, Math.round((new Date(until).getTime() - now) / 1000)) : 0;
  const sell = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await post(`/v1/holdings/${row.id}/sell`).catch(() => undefined);
    setDone(true);
  };
  return (
    <span className="small" style={{ marginLeft: 8 }}>
      <span className="badge badge-dry">{left > 0 ? `${left} sn` : "satılıyor"}</span>
      {!done && left > 0 && <button className="btn btn-sm" style={{ marginLeft: 6 }} onClick={sell}>Şimdi sat</button>}
    </span>
  );
}

function FixButton({ reason, leaderId }: { reason: string | null; leaderId: string | null }) {
  const fix = reason ? FIX[reason] : undefined;
  if (!fix) return null;
  return (
    <a className="btn btn-sm" style={{ marginLeft: 8 }} href={fix.href(leaderId)} onClick={(e) => e.stopPropagation()}>
      {fix.label}
    </a>
  );
}

function FragmentRow({ r, open, onToggle }: { r: LogRow & { more: number }; open: boolean; onToggle: () => void }) {
  const res = RESULT_TR[r.result] ?? { label: r.result, cls: "" };
  return (
    <>
      <tr className="clickable" onClick={onToggle}>
        <td className="muted num">{time(r.time)}</td>
        <td>
          <span style={{ fontWeight: 600 }}>{r.source.label}</span>
          {r.source.status === "paused" && <span className="badge" style={{ marginLeft: 6 }}>Duraklatıldı</span>}
          {r.dryRun && <span className="badge badge-dry" style={{ marginLeft: 6 }}>deneme</span>}
        </td>
        <td>{KIND_TR[r.kind] ?? r.kind}</td>
        <td><span className={`badge ${res.cls}`}>{res.label}</span></td>
        <td>
          {reasonTr(r.reason)}
          {r.more ? <span className="muted small"> · +{r.more} aynı nedenle</span> : null}
          <FixButton reason={r.reason} leaderId={r.source.id} />
          {r.result === "Holding" && <HoldCountdown row={r} />}
        </td>
        <td className={`num ${r.solDelta !== null && r.solDelta > 0 ? "pos" : ""}`}>{r.solDelta === null ? "—" : signed(r.solDelta)}</td>
        <td className="mono muted">{short(r.position?.pool, 4)}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={7} style={{ background: "var(--surface-2)" }}>
            <div className="small stack" style={{ gap: 6 }}>
              {r.leaderTx && <div>Lider işlemi: <a className="mono" href={`https://solscan.io/tx/${r.leaderTx}`} target="_blank" rel="noreferrer">{short(r.leaderTx, 8)}</a></div>}
              {r.signature && <div>Bizim işlemimiz: <a className="mono" href={`https://solscan.io/tx/${r.signature}`} target="_blank" rel="noreferrer">{short(r.signature, 8)}</a></div>}
              {r.source.position && <div>Lider pozisyonu: <span className="mono">{short(r.source.position, 8)}</span></div>}
              {r.position && <div>Pozisyonumuz: {r.position.ourPosition ? <span className="mono">{short(r.position.ourPosition, 8)}</span> : "deneme (zincirde yok)"} · yatırılan {solFmt(r.position.depositedSol)} · güncel {solFmt(r.position.valueSol)}{r.position.closeReason ? ` · kapanış: ${reasonTr(r.position.closeReason)}` : ""}</div>}
              {r.feeSol !== null && <div>Ağ ücreti: {r.feeSol.toFixed(6)} SOL</div>}
              {r.error && <div className="neg">Hata: {r.error}</div>}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
