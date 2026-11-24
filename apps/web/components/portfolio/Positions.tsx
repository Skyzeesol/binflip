"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { PfPosition } from "@/lib/types";
import { Amount, Pct, age, tone } from "@/components/Num";
import { short } from "@/lib/format";

const STRAT: Record<string, string> = { spot: "Spot", curve: "Curve", bid_ask: "BidAsk", custom: "Custom" };

export function PairCell({ p }: { p: PfPosition }) {
  const sym = p.token?.symbol ?? short(p.token?.mint ?? p.pool, 4);
  return (
    <div className="pair">
      <div className="pair-icons">
        <span className="pair-ph">{sym.slice(0, 1)}</span>
        {p.token?.icon && <img src={p.token.icon} alt="" onError={(e) => (e.currentTarget.style.display = "none")} />}
        <span className="pair-sol" aria-hidden>◎</span>
      </div>
      <div className="pair-text">
        <div className="pair-top">
          <a className="pair-name" href={`https://app.meteora.ag/${p.protocol === "dlmm" ? "dlmm" : "dammv2"}/${p.pool}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
            {sym} / SOL
          </a>
          <span className={`src src-${p.source}`} title={p.source === "auto" ? `Liderden kopyalandı${p.leaderLabel ? `: ${p.leaderLabel}` : ""}` : "Senin açtığın ya da cüzdanda bulunan pozisyon"}>
            {p.source === "auto" ? "⚙ Auto" : "✎ Manual"}
          </span>
          {p.dryRun && <span className="src src-dry">dry run</span>}
          {p.token?.holders !== null && p.token?.holders !== undefined && p.token.holders < 100 && <span className="warn-ico" title={`Çok az holder: ${p.token.holders}`}>⚠</span>}
        </div>
        <div className="pair-sub">
          <span className="proto">{p.protocol === "dlmm" ? "DLMM" : "DAMM V2"}</span>
          <span className="mono muted">{p.position ? short(p.position, 6) : p.leaderPosition ? short(p.leaderPosition, 6) : "—"}</span>
          {p.strategy && <span className="muted">{STRAT[p.strategy] ?? p.strategy}</span>}
          {p.flips ? <span className="muted">· {p.flips} flip</span> : null}
        </div>
      </div>
    </div>
  );
}

/** Range bar: lower %, the current price marker, upper % (LP Agent "Range" column). */
export function RangeBar({ p, mode }: { p: PfPosition; mode: "pct" | "bins" }) {
  const r = p.range;
  if (!r) return <span className="muted">—</span>;
  const { lower, upper, active } = p.bins;
  const span = Math.max(1, (upper ?? 0) - (lower ?? 0));
  // Marker inside the bar; outside the range it pins to the edge it left from.
  const pos = active === null || lower === null ? 50 : Math.min(100, Math.max(0, ((active - lower) / span) * 100));
  return (
    <div className={`rangebar ${r.inRange ? "" : "out"}`} title={r.inRange ? "Aralık içinde" : "Aralık dışında"}>
      <div className="rangebar-labels">
        <span>{mode === "pct" ? `${r.lowerPct > 0 ? "+" : ""}${r.lowerPct.toFixed(1)}%` : lower}</span>
        <span>{mode === "pct" ? `${r.upperPct > 0 ? "+" : ""}${r.upperPct.toFixed(1)}%` : upper}</span>
      </div>
      <div className="rangebar-track">
        <span className="rangebar-dot" style={{ left: "8%" }} />
        <span className="rangebar-dot" style={{ left: "92%" }} />
        <span className="rangebar-now" style={{ left: `${8 + pos * 0.84}%` }} />
      </div>
    </div>
  );
}

export function ActionMenu({ items }: { items: Array<{ label: string; onClick: () => void; danger?: boolean; disabled?: boolean }> }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <div className="menu" ref={ref} onClick={(e) => e.stopPropagation()}>
      <button className="btn btn-sm btn-ghost menu-btn" aria-label="İşlemler" onClick={() => setOpen(!open)}>⋮</button>
      {open && (
        <div className="menu-pop">
          {items.map((it) => (
            <button
              key={it.label}
              className={it.danger ? "neg" : ""}
              disabled={it.disabled}
              onClick={() => {
                setOpen(false);
                it.onClick();
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

type SortKey = "age" | "invested" | "value" | "fee" | "pnl" | "dpr" | "closed";

function useSort(list: PfPosition[], initial: SortKey, dirInit: 1 | -1) {
  const [key, setKey] = useState<SortKey>(initial);
  const [dir, setDir] = useState<1 | -1>(dirInit);
  const sorted = useMemo(() => {
    const val = (p: PfPosition): number =>
      key === "age" ? (p.ageMs ?? 0) : key === "invested" ? p.invested : key === "value" ? (p.value ?? 0) : key === "fee" ? p.totalFee : key === "pnl" ? (p.pnl ?? 0) : key === "dpr" ? (p.dpr ?? 0) : new Date(p.closedAt ?? 0).getTime();
    return [...list].sort((a, b) => (val(a) - val(b)) * dir);
  }, [list, key, dir]);
  const th = (k: SortKey, label: string, cls = "num") => (
    <th className={`${cls} sortable ${key === k ? "sorted" : ""}`} onClick={() => (key === k ? setDir((d) => (d === 1 ? -1 : 1)) : (setKey(k), setDir(-1)))}>
      {key === k ? (dir === 1 ? "↑ " : "↓ ") : ""}
      {label}
    </th>
  );
  return { sorted, th };
}

export interface RowActions {
  open: (p: PfPosition) => void;
  menu: (p: PfPosition) => Array<{ label: string; onClick: () => void; danger?: boolean; disabled?: boolean }>;
  exits: (p: PfPosition) => void;
}

export function OpenPositions({ list, actions }: { list: PfPosition[]; actions: RowActions }) {
  const [group, setGroup] = useState(false);
  const [proto, setProto] = useState<"all" | "dlmm" | "damm_v2">("all");
  const [view, setView] = useState<"table" | "card">("table");
  const [rangeMode, setRangeMode] = useState<"pct" | "bins">("pct");
  const shown = list.filter((p) => proto === "all" || p.protocol === proto);
  const { sorted, th } = useSort(shown, "age", 1);
  const t = {
    value: shown.reduce((s, p) => s + (p.value ?? 0), 0),
    invested: shown.reduce((s, p) => s + p.invested, 0),
    upnl: shown.reduce((s, p) => s + (p.pnl ?? 0), 0),
    claimed: shown.reduce((s, p) => s + p.claimedFee, 0),
    unclaimed: shown.reduce((s, p) => s + (p.unclaimedFee ?? 0), 0),
    fee: shown.reduce((s, p) => s + p.totalFee, 0),
  };
  const pct = (v: number) => (t.invested > 0 ? (v / t.invested) * 100 : null);
  const rows = group ? groupByPool(sorted) : sorted.map((p) => ({ key: p.id, items: [p] }));

  return (
    <section className="card pf-section">
      <div className="pf-section-head">
        <div>
          <h2>Open Positions ({shown.length})</h2>
          <div className="pf-totals">
            <span>Total value <b><Amount sol={t.value} d={2} /></b></span>
            <span>Total uPnL <b className={tone(t.upnl)}><Amount sol={t.upnl} d={2} /></b> <Pct v={pct(t.upnl)} className={tone(t.upnl)} /></span>
            <span>Claimed fees <b className="pos"><Amount sol={t.claimed} d={2} /></b></span>
            <span>Unclaimed fees <b className="pos"><Amount sol={t.unclaimed} d={2} /></b></span>
          </div>
        </div>
        <div className="pf-tools">
          <label className="toggle-label">Group by pool <button className={`switch ${group ? "on" : ""}`} onClick={() => setGroup(!group)} aria-pressed={group} /></label>
          <select className="sel" value={proto} onChange={(e) => setProto(e.target.value as typeof proto)} aria-label="Tip">
            <option value="all">Type: All</option>
            <option value="dlmm">DLMM</option>
            <option value="damm_v2">DAMM V2</option>
          </select>
          <ViewToggle view={view} setView={setView} />
        </div>
      </div>
      {view === "table" ? (
        <div className="table-wrap">
          <table className="pf-table">
            <thead>
              <tr>
                <th style={{ width: 28 }} />
                <th>Position/Pool</th>
                {th("age", "Age")}
                {th("invested", "Invested")}
                {th("value", "Value")}
                {th("fee", "Total fee")}
                {th("pnl", "uPnL")}
                {th("dpr", "DPR")}
                <th>
                  <span className="range-head">
                    Range
                    <button className={rangeMode === "bins" ? "on" : ""} onClick={() => setRangeMode("bins")} title="Bin" aria-label="Bin">☰</button>
                    <button className={rangeMode === "pct" ? "on" : ""} onClick={() => setRangeMode("pct")} title="Fiyattan %" aria-label="Yüzde">%</button>
                  </span>
                </th>
                <th>TP/SL</th>
                <th className="num">Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((g) =>
                g.items.map((p, i) => (
                  <tr key={p.id} className={`clickable ${group && i > 0 ? "grouped" : ""}`} onClick={() => actions.open(p)}>
                    <td><span className="chart-ico" title="Detay">📈</span></td>
                    <td><PairCell p={p} /></td>
                    <td className="num">{age(p.ageMs)}</td>
                    <td className="num"><Amount sol={p.invested} /></td>
                    <td className="num"><Amount sol={p.value} /></td>
                    <td className="num"><div className="pos"><Amount sol={p.totalFee} /></div><div className="pos small"><Pct v={p.feePct} /></div></td>
                    <td className="num"><div className={tone(p.pnl)}><Amount sol={p.pnl} /></div><div className={`small ${tone(p.pnl)}`}><Pct v={p.pnlPct} /></div></td>
                    <td className={`num ${tone(p.dpr)}`}><Pct v={p.dpr} /></td>
                    <td style={{ minWidth: 190 }}><RangeBar p={p} mode={rangeMode} /></td>
                    <td>
                      <button className="exits-badge" onClick={(e) => (e.stopPropagation(), actions.exits(p))}>
                        {p.exits.takeProfitPct || p.exits.stopLossPct ? `TP ${p.exits.takeProfitPct ?? "—"}% · SL ${p.exits.stopLossPct ?? "—"}%` : "Set"}
                      </button>
                    </td>
                    <td className="num"><ActionMenu items={actions.menu(p)} /></td>
                  </tr>
                )),
              )}
              {!shown.length && (
                <tr><td colSpan={11} className="empty"><b>No positions</b><div className="small">Bir lider pozisyon açınca kopyası burada görünür.</div></td></tr>
              )}
              {shown.length > 0 && (
                <tr className="total-row">
                  <td />
                  <td><b>Total</b></td>
                  <td />
                  <td className="num"><Amount sol={t.invested} /></td>
                  <td className="num"><Amount sol={t.value} /></td>
                  <td className="num"><div className="pos"><Amount sol={t.fee} /></div><div className="pos small"><Pct v={pct(t.fee)} /></div></td>
                  <td className="num"><div className={tone(t.upnl)}><Amount sol={t.upnl} /></div><div className={`small ${tone(t.upnl)}`}><Pct v={pct(t.upnl)} /></div></td>
                  <td colSpan={4} />
                </tr>
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <Cards list={sorted} actions={actions} open />
      )}
    </section>
  );
}

export interface HistFilter {
  protocol: "all" | "dlmm" | "damm_v2";
  source: "all" | "auto" | "manual";
  pool: string;
  minPnl: string;
  maxPnl: string;
}
export const EMPTY_FILTER: HistFilter = { protocol: "all", source: "all", pool: "", minPnl: "", maxPnl: "" };

export function HistoricalPositions(p: {
  list: PfPosition[];
  pools: Array<{ pool: string; token: string | null }>;
  filter: HistFilter;
  setFilter: (f: HistFilter) => void;
  actions: RowActions;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(p.filter);
  const [hideSmall, setHideSmall] = useState(false);
  const [view, setView] = useState<"table" | "card">("table");
  const list = hideSmall ? p.list.filter((x) => Math.abs(x.pnl ?? 0) >= 0.001) : p.list;
  const { sorted, th } = useSort(list, "closed", -1);
  const active = [p.filter.protocol !== "all", p.filter.source !== "all", !!p.filter.pool, !!p.filter.minPnl || !!p.filter.maxPnl].filter(Boolean).length;

  return (
    <section className="card pf-section">
      <div className="pf-section-head">
        <h2>Historical Positions</h2>
        <div className="pf-tools">
          <div className="pop-wrap">
            <button className="btn btn-sm" onClick={() => (setDraft(p.filter), setOpen(!open))}>⛉ Filters{active ? ` (${active})` : ""}</button>
            {open && (
              <div className="pop">
                <label className="field small">Type
                  <select value={draft.protocol} onChange={(e) => setDraft({ ...draft, protocol: e.target.value as HistFilter["protocol"] })}>
                    <option value="all">All</option>
                    <option value="dlmm">DLMM</option>
                    <option value="damm_v2">DAMM V2</option>
                  </select>
                </label>
                <div className="field small">Source
                  <div className="seg full">
                    {(["all", "manual", "auto"] as const).map((s) => (
                      <button key={s} className={draft.source === s ? "on" : ""} onClick={() => setDraft({ ...draft, source: s })}>{s === "all" ? "All" : s === "manual" ? "✎ Manual" : "⚙ Auto"}</button>
                    ))}
                  </div>
                </div>
                <label className="field small">Pool
                  <select value={draft.pool} onChange={(e) => setDraft({ ...draft, pool: e.target.value })}>
                    <option value="">All pools</option>
                    {p.pools.map((x) => <option key={x.pool} value={x.pool}>{x.token ? `${x.token} / SOL` : short(x.pool, 6)}</option>)}
                  </select>
                </label>
                <div className="field small">PnL (SOL)
                  <div className="minmax">
                    <input type="number" placeholder="Min" value={draft.minPnl} onChange={(e) => setDraft({ ...draft, minPnl: e.target.value })} />
                    <span>-</span>
                    <input type="number" placeholder="Max" value={draft.maxPnl} onChange={(e) => setDraft({ ...draft, maxPnl: e.target.value })} />
                  </div>
                </div>
                <div className="pop-foot">
                  <button className="btn" onClick={() => (p.setFilter(EMPTY_FILTER), setDraft(EMPTY_FILTER), setOpen(false))}>Reset</button>
                  <button className="btn btn-primary" onClick={() => (p.setFilter(draft), setOpen(false))}>Apply</button>
                </div>
              </div>
            )}
          </div>
          <label className="toggle-label" title="Çok küçük (toz) PnL'li satırları gizler">Hide small PnL <button className={`switch ${hideSmall ? "on" : ""}`} onClick={() => setHideSmall(!hideSmall)} aria-pressed={hideSmall} /></label>
          <ViewToggle view={view} setView={setView} />
        </div>
      </div>
      {view === "table" ? (
        <div className="table-wrap">
          <table className="pf-table">
            <thead>
              <tr>
                <th style={{ width: 28 }} />
                <th>Position/Pool</th>
                {th("age", "Age")}
                {th("invested", "Invested")}
                {th("fee", "Total fee")}
                {th("pnl", "PnL")}
                {th("dpr", "DPR")}
                {th("closed", "Closed")}
                <th className="num">Action</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((x) => (
                <tr key={x.id} className="clickable" onClick={() => p.actions.open(x)}>
                  <td><span className="chart-ico" title="Detay">📈</span></td>
                  <td><PairCell p={x} /></td>
                  <td className="num">{age(x.ageMs)}</td>
                  <td className="num"><Amount sol={x.invested} /></td>
                  <td className="num"><div className="pos"><Amount sol={x.totalFee} /></div><div className="pos small"><Pct v={x.feePct} /></div></td>
                  <td className="num"><div className={tone(x.pnl)}><Amount sol={x.pnl} /></div><div className={`small ${tone(x.pnl)}`}><Pct v={x.pnlPct} /></div></td>
                  <td className={`num ${tone(x.dpr)}`}><Pct v={x.dpr} /></td>
                  <td className="num muted">{closedAt(x.closedAt)}</td>
                  <td className="num"><ActionMenu items={p.actions.menu(x)} /></td>
                </tr>
              ))}
              {!sorted.length && <tr><td colSpan={9} className="empty">Kapanmış pozisyon yok.</td></tr>}
            </tbody>
          </table>
        </div>
      ) : (
        <Cards list={sorted} actions={p.actions} />
      )}
    </section>
  );
}

function Cards({ list, actions, open = false }: { list: PfPosition[]; actions: RowActions; open?: boolean }) {
  if (!list.length) return <div className="empty">Pozisyon yok.</div>;
  return (
    <div className="pf-cards">
      {list.map((p) => (
        <div key={p.id} className="pf-card" onClick={() => actions.open(p)}>
          <div className="pf-card-top">
            <PairCell p={p} />
            <ActionMenu items={actions.menu(p)} />
          </div>
          <div className="pf-card-grid">
            <span className="muted">Age</span><span>{age(p.ageMs)}</span>
            <span className="muted">Invested</span><span><Amount sol={p.invested} /></span>
            {open && <><span className="muted">Value</span><span><Amount sol={p.value} /></span></>}
            <span className="muted">Total fee</span><span className="pos"><Amount sol={p.totalFee} /> · <Pct v={p.feePct} /></span>
            <span className="muted">{open ? "uPnL" : "PnL"}</span><span className={tone(p.pnl)}><Amount sol={p.pnl} /> · <Pct v={p.pnlPct} /></span>
            <span className="muted">DPR</span><span className={tone(p.dpr)}><Pct v={p.dpr} /></span>
            {!open && <><span className="muted">Closed</span><span>{closedAt(p.closedAt)}</span></>}
          </div>
          {open && <RangeBar p={p} mode="pct" />}
        </div>
      ))}
    </div>
  );
}

function ViewToggle({ view, setView }: { view: "table" | "card"; setView: (v: "table" | "card") => void }) {
  return (
    <div className="seg">
      <button className={view === "card" ? "on" : ""} onClick={() => setView("card")}>▦ Card</button>
      <button className={view === "table" ? "on" : ""} onClick={() => setView("table")}>▤ Table</button>
    </div>
  );
}

function groupByPool(list: PfPosition[]) {
  const m = new Map<string, PfPosition[]>();
  for (const p of list) m.set(p.pool, [...(m.get(p.pool) ?? []), p]);
  return [...m.entries()].map(([key, items]) => ({ key, items }));
}

/** "4 hours ago" for today, a date + time before that (as in LP Agent). */
export function closedAt(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const h = (Date.now() - d.getTime()) / 3_600_000;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} dk önce`;
  if (h < 24) return `${Math.round(h)} saat önce`;
  return d.toLocaleString("tr-TR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
