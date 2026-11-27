"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api, post } from "@/lib/api";
import type { Account, Me } from "@/lib/types";
import { Amount, NetWorth } from "@/components/Num";
import { short } from "@/lib/format";

/**
 * LP Agent account panel: agent wallet, balances, deposit address, withdraw.
 * Withdraw only goes to the main wallet set on the server; the panel never sees a key.
 */
export function AccountPanel({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const [acc, setAcc] = useState<Account | null>(null);
  const [amount, setAmount] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    void api<Account>("/v1/account").then(setAcc).catch(() => undefined);
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const withdraw = async (max = false) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await post<{ to: string }>("/v1/account/withdraw", { amountSol: max ? "max" : Number(amount) });
      setMsg(`Çekim kuyruğa alındı → ${short(r.to, 6)}. Telegram'a bildirim gelecek.`);
      setAmount("");
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const wallet = acc?.wallet ?? me.agentWallets[0]?.publicKey ?? null;
  return (
    <div className="acct" ref={ref}>
      <button className="btn btn-sm acct-btn" onClick={() => setOpen(!open)}>
        <span className="dot" style={{ color: me.mode === "live" ? "var(--neg)" : "var(--warn)" }} /> {wallet ? short(wallet, 4) : "Hesap"} ▾
      </button>
      {open && (
        <div className="acct-pop" lang="en">
          <div className="kpi-label">AGENT WALLET {me.mode === "live" ? <span className="badge badge-live">LIVE</span> : <span className="badge badge-dry">DRY RUN</span>}</div>
          {wallet ? (
            <div className="acct-addr">
              <span className="mono">{wallet}</span>
              <button className="btn btn-sm btn-ghost" onClick={() => navigator.clipboard.writeText(wallet)} aria-label="Kopyala">⧉</button>
            </div>
          ) : (
            <div className="note">Bot cüzdanı yok. Sunucuda <code>wallet:create</code> ile oluşturulur (README 6. adım).</div>
          )}
          <div className="acct-grid">
            <span className="muted">SOL</span><b><Amount sol={acc?.sol ?? null} /></b>
            <span className="muted">Tokens</span><b><Amount sol={acc?.tokensValue ?? null} /></b>
            <span className="muted">Positions</span><b><Amount sol={acc?.positionsValue ?? null} /></b>
            <span className="muted">Net worth</span><b><NetWorth acc={acc} d={4} /></b>
          </div>
          {!!acc?.tokens.length && (
            <div className="acct-tokens">
              {acc.tokens.slice(0, 8).map((t) => (
                <div key={t.mint}>
                  {t.icon ? <img src={t.icon} alt="" width={16} height={16} /> : null} {t.symbol ?? short(t.mint, 4)} <span className="muted">{t.amount.toLocaleString("tr-TR", { maximumFractionDigits: 4 })}</span>
                </div>
              ))}
            </div>
          )}
          {wallet && (
            <>
              <div className="kpi-label" style={{ marginTop: 12 }}>DEPOSIT</div>
              <div className="note">Bu adrese SOL gönder (Phantom/Jupiter'den). Sadece Solana ağı.</div>
              <div className="kpi-label" style={{ marginTop: 12 }}>WITHDRAW TO MAIN WALLET</div>
              {acc?.mainWallet ? (
                <>
                  <div className="small muted">Alıcı (sunucuda sabit): <span className="mono">{short(acc.mainWallet, 6)}</span></div>
                  <div className="acct-withdraw">
                    <input type="number" min={0} step="0.01" placeholder="SOL" value={amount} onChange={(e) => setAmount(e.target.value)} />
                    <button className="btn btn-sm" disabled={busy || !(Number(amount) > 0)} onClick={() => withdraw(false)}>Withdraw</button>
                    <button className="btn btn-sm" disabled={busy} onClick={() => confirm("Bot cüzdanındaki SOL'ün tamamı (işlem ücreti payı hariç) ana cüzdana gönderilsin mi? Açık pozisyonlar etkilenmez.") && withdraw(true)}>Max</button>
                  </div>
                </>
              ) : (
                <div className="note">Sunucuda ana cüzdan adresi (SWEEP_TO_ADDRESS) tanımlı değil.</div>
              )}
              {msg && <div className="small" style={{ marginTop: 6 }}>{msg}</div>}
            </>
          )}
          {!!acc?.emptyAccounts && acc.mode === "live" && (
            <div className="note">
              {acc.emptyAccounts} boş token hesabında ~{(acc.claimableSol ?? 0).toFixed(4)} SOL rent var.{" "}
              <button className="btn btn-sm" onClick={() => void post("/v1/account/claim-sol").then(() => setMsg("Claim SOL kuyruğa alındı.")).catch((e) => setMsg((e as Error).message))}>Claim SOL</button>
            </div>
          )}
          <div className="acct-foot">
            <Link className="btn btn-sm btn-ghost" href="/settings" onClick={() => setOpen(false)}>Settings</Link>
            <div className="spacer" />
            <button className="btn btn-sm btn-ghost" onClick={onLogout} title={me.user.loginWallet}>Log out ({me.user.username ?? short(me.user.loginWallet, 4)})</button>
          </div>
        </div>
      )}
    </div>
  );
}
