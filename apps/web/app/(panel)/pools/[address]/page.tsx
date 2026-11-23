"use client";

import { use, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { api, post } from "@/lib/api";
import type { Account, Prefs } from "@/lib/types";
import { Amount, compact } from "@/components/Num";
import { CandleChart } from "@/components/pools/Candles";
import { closedAt } from "@/components/portfolio/Positions";
import { short } from "@/lib/format";
import type { PoolRow } from "../page";

interface PoolPage {
  protocol: "dlmm" | "damm_v2";
  pool: PoolRow & { solIsX: boolean };
  reserves: { x: number; y: number };
  fees24h: number;
  volume24h: number;
  feeTvl: Record<string, number>;
  dynamicFeePct: number;
  maxFeePct: number;
  token: { symbol: string | null; name: string | null; icon: string | null; organicScore: number | null; mcapUsd: number | null; holders: number | null; volume24hUsd: number | null; createdAt: string | null } | null;
  mine: Array<{ id: string; state: string; dryRun: boolean; source: string; origin: string | null; strategy: string | null; invested: number; value: number | null; lower: number | null; upper: number | null; openedAt: string; closedAt: string | null }>;
  links: Record<string, string>;
}
interface Estimate { lower: number; upper: number; bins: number; tokenShare: number; newBinArrays: number | null; positionRentSol: number; newBinRentSol: number | null; swapBufferSol: number }

const money = (v: number) => `$${compact(v, 2)}`;
const PRESETS = [
  { id: "±5", lo: -5, hi: 5 },
  { id: "±10", lo: -10, hi: 10 },
  { id: "-50", lo: -50, hi: 0 },
  { id: "-70", lo: -70, hi: 0 },
];

export default function PoolPage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = use(params);
  const sp = useSearchParams();
  const protocol = (sp.get("protocol") as "dlmm" | "damm_v2") ?? "dlmm";
  const [d, setD] = useState<PoolPage | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<"open" | "history">("open");
  const [range, setRange] = useState({ lo: -5, hi: 5 });

  const load = () => void api<PoolPage>(`/v1/pools/${address}?protocol=${protocol}`).then(setD).catch((e) => setErr((e as Error).message));
  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, protocol]);

  const p = d?.pool;
  const lines = p && protocol === "dlmm" ? { min: p.price * (1 + range.lo / 100), max: p.price * (1 + range.hi / 100) } : null;
  const mine = (d?.mine ?? []).filter((m) => (tab === "open" ? m.state !== "CLOSED" : m.state === "CLOSED"));

  return (
    <main className="page page-wide">
      {err && <div className="banner banner-neg">{err}</div>}
      {p && (
        <div className="pool-head card">
          <div className="pair">
            <div className="pair-icons">
              <span className="pair-ph">{p.base.symbol?.slice(0, 1)}</span>
              {(d?.token?.icon ?? p.base.icon) && <img src={(d?.token?.icon ?? p.base.icon)!} alt="" onError={(e) => (e.currentTarget.style.display = "none")} />}
              <span className="pair-sol" aria-hidden>◎</span>
            </div>
            <div className="pair-text">
              <div className="pair-top"><b style={{ fontSize: 18 }}>{p.base.symbol} / {p.quote.symbol}</b><span className="proto">{protocol === "dlmm" ? `DLMM · bin ${p.binStep}` : "DAMM V2"}</span><span className="muted small">taban fee {p.baseFeePct}%{d && d.dynamicFeePct > 0 ? ` · dinamik ${d.dynamicFeePct.toFixed(3)}%` : ""}</span></div>
              <div className="pair-sub">
                <span className="mono muted">{short(address, 6)}</span>
                <button className="btn btn-sm btn-ghost" onClick={() => navigator.clipboard.writeText(address)} aria-label="Adresi kopyala">⧉</button>
                {d && Object.entries(d.links).map(([k, v]) => <a key={k} className="muted" href={v} target="_blank" rel="noreferrer">{k === "meteora" ? "Meteora" : k === "dexscreener" ? "DexScreener" : k === "gmgn" ? "GMGN" : k === "solscan" ? "Solscan" : "Bubblemaps"} ↗</a>)}
              </div>
            </div>
          </div>
          <div className="pool-stats">
            <Stat l="Fiyat" v={`${p.price.toPrecision(4)} SOL`} />
            <Stat l="Piyasa değeri" v={p.base.mcap ? money(p.base.mcap) : "—"} />
            <Stat l="TVL" v={money(p.tvl)} />
            <Stat l="Hacim 24s" v={money(d!.volume24h)} />
            <Stat l="Fee 24s" v={money(d!.fees24h)} />
            <Stat l="Fee/TVL 24s" v={`${(d!.feeTvl["24h"] ?? 0).toFixed(2)}%`} cls="pos" />
            <Stat l="Fee/TVL 1s" v={`${(d!.feeTvl["1h"] ?? 0).toFixed(2)}%`} cls="pos" />
            <Stat l="Tah. APR" v={`${compact(p.apr, 1)}%`} />
          </div>
        </div>
      )}

      <div className="pool-grid">
        <div className="stack" style={{ minWidth: 0 }}>
          <section className="card card-pad">{p && <CandleChart pool={address} protocol={protocol} lines={lines} />}</section>
          {d?.token && (
            <section className="card card-pad pool-token">
              <Stat l="Organic score" v={d.token.organicScore === null ? "—" : d.token.organicScore.toFixed(0)} cls={d.token.organicScore !== null && d.token.organicScore < 50 ? "neg" : ""} />
              <Stat l="Holder" v={d.token.holders?.toLocaleString("tr-TR") ?? "—"} cls={d.token.holders !== null && d.token.holders < 100 ? "neg" : ""} />
              <Stat l="Token hacmi 24s" v={d.token.volume24hUsd ? money(d.token.volume24hUsd) : "—"} />
              <Stat l="Token yaşı" v={d.token.createdAt ? closedAt(d.token.createdAt) : "—"} />
              <Stat l="Havuzdaki token" v={`${compact(d.reserves.x, 2)} ${p?.base.symbol}`} />
              <Stat l="Havuzdaki SOL" v={`${compact(d.reserves.y, 2)}`} />
            </section>
          )}
          <section className="card">
            <div className="tabs" style={{ padding: "0 12px", marginBottom: 0 }}>
              <button className={`tab ${tab === "open" ? "active" : ""}`} onClick={() => setTab("open")}>Pozisyonların</button>
              <button className={`tab ${tab === "history" ? "active" : ""}`} onClick={() => setTab("history")}>Geçmiş</button>
            </div>
            <div className="table-wrap">
              <table className="pf-table">
                <thead><tr><th>Pozisyon</th><th>Kaynak</th><th className="num">Yatırılan</th><th className="num">Değer</th><th>Aralık (bin)</th><th className="num">{tab === "open" ? "Açılış" : "Kapanış"}</th></tr></thead>
                <tbody>
                  {mine.map((m) => (
                    <tr key={m.id} className="clickable" onClick={() => (window.location.href = "/portfolio")}>
                      <td>{m.strategy ?? "—"} {m.dryRun && <span className="src src-dry">deneme</span>}</td>
                      <td><span className={`src src-${m.source}`}>{m.source === "auto" ? "⚙ Auto" : m.origin === "telegram" ? "✎ Telegram" : "✎ Manual"}</span></td>
                      <td className="num"><Amount sol={m.invested} /></td>
                      <td className="num"><Amount sol={m.value} /></td>
                      <td className="mono muted">{m.lower}..{m.upper}</td>
                      <td className="num muted">{closedAt(tab === "open" ? m.openedAt : m.closedAt)}</td>
                    </tr>
                  ))}
                  {!mine.length && <tr><td colSpan={6} className="empty">Bu havuzda {tab === "open" ? "açık" : "kapanmış"} pozisyonun yok.</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
        </div>
        {p && <CreatePanel address={address} protocol={protocol} pool={p} range={range} setRange={setRange} onOpened={load} />}
      </div>
    </main>
  );
}

function Stat({ l, v, cls = "" }: { l: string; v: React.ReactNode; cls?: string }) {
  return (
    <div>
      <div className="kpi-label">{l}</div>
      <div className={`stat-v ${cls}`}>{v}</div>
    </div>
  );
}

/** LP Agent "Create Position" panel + Binflip's management options (flip, fees, TP/SL). */
function CreatePanel(p: { address: string; protocol: "dlmm" | "damm_v2"; pool: PoolRow & { solIsX: boolean }; range: { lo: number; hi: number }; setRange: (r: { lo: number; hi: number }) => void; onOpened: () => void }) {
  const [acc, setAcc] = useState<Account | null>(null);
  const [amount, setAmount] = useState("0.5");
  const [strategy, setStrategy] = useState<"spot" | "curve" | "bid_ask">("bid_ask");
  const [mode, setMode] = useState<"mirror" | "staged_flip" | "bottom_flip">("staged_flip");
  const [flip, setFlip] = useState("10");
  const [feeMode, setFeeMode] = useState<"compound" | "sell" | "hold">("compound");
  const [interval, setInterval_] = useState("60");
  const [tp, setTp] = useState("");
  const [sl, setSl] = useState("");
  const [tr, setTr] = useState("");
  const [est, setEst] = useState<Estimate | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const dlmm = p.protocol === "dlmm";
  const activeBin = useMemo(() => {
    // Price per bin: (1 + binStep/1e4)^bin in raw units; the API's estimate needs the active bin, so derive it from the price.
    // UI price (SOL per token) → raw price (lamports per raw token unit): × 10^(9 − token decimals).
    const decimals = p.pool.base.decimals ?? 6;
    const raw = p.pool.price * Math.pow(10, 9 - decimals);
    return Math.round(Math.log(raw) / Math.log(1 + p.pool.binStep / 10_000));
  }, [p.pool]);

  useEffect(() => {
    void api<Account>("/v1/account").then(setAcc).catch(() => undefined);
    // Settings → Auto TP/SL prefills the exits of a new position.
    void api<Prefs>("/v1/prefs")
      .then((pr) => {
        if (pr.autoTpSl.enabled) {
          setTp(String(pr.autoTpSl.takeProfitPct));
          setSl(String(pr.autoTpSl.stopLossPct));
        }
      })
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!dlmm || !Number.isFinite(activeBin)) return;
    const t = setTimeout(
      () =>
        void api<Estimate>(`/v1/pools/${p.address}/estimate?lowerPct=${p.range.lo}&upperPct=${p.range.hi}&activeBin=${activeBin}&binStep=${p.pool.binStep}`)
          .then(setEst)
          .catch((e) => setMsg({ ok: false, text: (e as Error).message })),
      300,
    );
    return () => clearTimeout(t);
  }, [p.range, activeBin, dlmm, p.address, p.pool.binStep]);

  const amt = Number(amount) || 0;
  const costs = dlmm && est ? amt + est.swapBufferSol + est.positionRentSol + (est.newBinRentSol ?? 0) : amt + 0.02 + 0.02;
  const bal = acc?.sol ?? null;
  const short_ = bal !== null && acc?.mode === "live" && costs > bal;
  const maxAmt = bal === null ? 0 : Math.max(0, bal - (costs - amt) - 0.01);

  const open = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const num = (v: string) => (v.trim() === "" ? null : Number(v));
      const r = await post<{ mode: string }>(`/v1/pools/${p.address}/open`, {
        protocol: p.protocol,
        amountSol: amt,
        lowerPct: p.range.lo,
        upperPct: p.range.hi,
        strategy,
        managementMode: mode,
        flipThresholdPct: mode === "staged_flip" ? Number(flip) : undefined,
        feeMode,
        compoundMinutes: feeMode === "hold" ? undefined : Number(interval),
        takeProfitPct: num(tp),
        stopLossPct: num(sl),
        trailingPct: num(tr),
      });
      setMsg({ ok: true, text: r.mode === "live" ? "Pozisyon açma kuyruğa alındı. Açılınca Telegram'a bildirim gelir." : "Deneme modu: pozisyon kaydedildi ve simüle edilecek (zincire işlem gitmez)." });
      setTimeout(p.onOpened, 2500);
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="card create-panel">
      <h3>Pozisyon aç</h3>
      <div className="field small">Yatırılacak SOL
        <div className="amount-row">
          <input type="number" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <button className="btn btn-sm" onClick={() => setAmount((maxAmt / 2).toFixed(3))} disabled={!bal}>YARI</button>
          <button className="btn btn-sm" onClick={() => setAmount(maxAmt.toFixed(3))} disabled={!bal}>MAX</button>
        </div>
        <div className="chips">
          {[0.1, 0.5, 1, 5].map((v) => <button key={v} className={`chip ${amt === v ? "on" : ""}`} disabled={bal !== null && acc?.mode === "live" && v > bal} onClick={() => setAmount(String(v))}>{v} SOL</button>)}
        </div>
        <span className="hint">Bakiye: {bal === null ? "—" : `${bal.toFixed(4)} SOL`}{acc?.mode !== "live" ? " (deneme modu)" : ""}</span>
      </div>

      {dlmm && (
        <>
          <div className="field small">Strateji
            <div className="seg full">
              {(["spot", "curve", "bid_ask"] as const).map((s) => <button key={s} className={strategy === s ? "on" : ""} onClick={() => setStrategy(s)}>{s === "spot" ? "Spot" : s === "curve" ? "Curve" : "Bid-Ask"}</button>)}
            </div>
            <ShapePreview strategy={strategy} lo={p.range.lo} hi={p.range.hi} />
          </div>
          <div className="field small">Aralık (fiyattan %)
            <div className="chips">
              {PRESETS.map((r) => <button key={r.id} className={`chip ${p.range.lo === r.lo && p.range.hi === r.hi ? "on" : ""}`} onClick={() => p.setRange({ lo: r.lo, hi: r.hi })}>{r.id}%</button>)}
            </div>
            <div className="minmax">
              <input type="number" value={p.range.lo} onChange={(e) => p.setRange({ ...p.range, lo: Number(e.target.value) })} aria-label="Alt %" />
              <span>-</span>
              <input type="number" value={p.range.hi} onChange={(e) => p.setRange({ ...p.range, hi: Number(e.target.value) })} aria-label="Üst %" />
            </div>
            <span className="hint">
              {est ? `${est.bins} bin · ${est.tokenShare > 0 ? `SOL'ün ~%${Math.round(est.tokenShare * 100)}'i token'a çevrilir (zap)` : "sadece SOL, swap yok"}` : "—"}
              {" · "}min {(p.pool.price * (1 + p.range.lo / 100)).toPrecision(4)} · max {(p.pool.price * (1 + p.range.hi / 100)).toPrecision(4)} SOL
            </span>
          </div>
        </>
      )}
      {!dlmm && <div className="note">DAMM V2: tutarı yaz, yeter. Strateji ve aralık yok; SOL havuzun oranına göre bölünür (yarısı token'a çevrilir).</div>}

      <div className="divider">Binflip yönetimi</div>
      {dlmm && (
        <label className="field small">Yönetim modu
          <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
            <option value="staged_flip">Kademeli flip</option>
            <option value="bottom_flip">Dipte flip</option>
            <option value="mirror">Sadece tut (yönetme)</option>
          </select>
        </label>
      )}
      {dlmm && mode === "staged_flip" && <label className="field small">Flip eşiği (%)<input type="number" min={1} value={flip} onChange={(e) => setFlip(e.target.value)} /></label>}
      <div className="field small">Fee'ler
        <div className="seg full">
          <button className={feeMode === "compound" ? "on" : ""} onClick={() => setFeeMode("compound")} disabled={!dlmm}>Auto-compound</button>
          <button className={feeMode === "sell" ? "on" : ""} onClick={() => setFeeMode("sell")}>Sürekli SOL'e sat</button>
          <button className={feeMode === "hold" ? "on" : ""} onClick={() => setFeeMode("hold")}>Bekle</button>
        </div>
      </div>
      {feeMode !== "hold" && <label className="field small">Her kaç dakikada (eşik aşılınca)<input type="number" min={5} value={interval} onChange={(e) => setInterval_(e.target.value)} /></label>}
      <div className="row3">
        <label className="field small">TP %<input type="number" placeholder="—" value={tp} onChange={(e) => setTp(e.target.value)} /></label>
        <label className="field small">SL %<input type="number" placeholder="—" value={sl} onChange={(e) => setSl(e.target.value)} /></label>
        <label className="field small">Trailing %<input type="number" placeholder="—" value={tr} onChange={(e) => setTr(e.target.value)} /></label>
      </div>

      <div className="cost">
        <div><span>Yatırılan</span><b>{amt.toFixed(4)} SOL</b></div>
        <div><span>Swap ve işlem ücreti payı</span><b>{(dlmm && est ? est.swapBufferSol : 0.02).toFixed(4)} SOL</b></div>
        <div><span>Pozisyon rent'i (geri gelir)</span><b>{(dlmm && est ? est.positionRentSol : 0.02).toFixed(4)} SOL</b></div>
        {dlmm && <div><span>Yeni bin rent'i (geri gelmez)</span><b className={est?.newBinRentSol ? "neg" : ""}>{est?.newBinRentSol === null || !est ? "—" : `${est.newBinRentSol.toFixed(4)} SOL`}</b></div>}
        {dlmm && est?.newBinArrays ? <div className="small neg">Aralığın {est.newBinArrays} bin dizisi henüz açılmamış; ilk açan sen olursun. Aralığı daraltarak bunu önleyebilirsin.</div> : null}
        <div className="cost-total"><span>Gereken toplam</span><b>{costs.toFixed(4)} SOL</b></div>
      </div>
      {short_ && <div className="neg small">İşlem ücretleri için SOL yetmiyor.</div>}
      {msg && <div className={`small ${msg.ok ? "pos" : "neg"}`}>{msg.text}</div>}
      <button className="btn btn-primary create-btn" disabled={busy || amt <= 0 || short_} onClick={open}>{busy ? "Gönderiliyor…" : "Pozisyon aç"}</button>
      <div className="small muted">Bot cüzdanından açılır; cüzdan onayı istenmez. <Link className="link-accent" href="/settings">Slippage</Link></div>
    </aside>
  );
}

/** How the liquidity sits around the price for each strategy (LP Agent's preview chart). */
function ShapePreview({ strategy, lo, hi }: { strategy: "spot" | "curve" | "bid_ask"; lo: number; hi: number }) {
  const n = 28;
  const zero = Math.round((-lo / (hi - lo || 1)) * n);
  const bars = Array.from({ length: n }, (_, i) => {
    const t = Math.abs(i - zero) / Math.max(zero, n - zero, 1);
    const h = strategy === "spot" ? 0.6 : strategy === "curve" ? 1 - t * 0.85 : 0.15 + t * 0.85;
    return { h, below: i < zero };
  });
  return (
    <svg viewBox="0 0 280 60" width="100%" height="60" aria-label="Dağılım önizleme">
      {bars.map((b, i) => <rect key={i} x={i * 10 + 1} y={60 - b.h * 56} width="8" height={b.h * 56} rx="1.5" fill={b.below ? "var(--pos)" : "var(--manual)"} opacity="0.85" />)}
      <line x1={zero * 10} x2={zero * 10} y1="0" y2="60" stroke="#f5c542" strokeWidth="2" />
    </svg>
  );
}
