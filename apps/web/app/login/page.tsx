"use client";

import { useEffect, useState } from "react";
import { post } from "@/lib/api";
import { listWallets, onWalletsChanged, signIn, type WalletOption } from "@/lib/wallet";

export default function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [wallets, setWallets] = useState<WalletOption[]>([]);
  const [showWallets, setShowWallets] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const refresh = () => setWallets(listWallets());
    refresh();
    const off = onWalletsChanged(refresh);
    const t = setTimeout(refresh, 800); // some wallets inject late
    return () => {
      off();
      clearTimeout(t);
    };
  }, []);

  const passwordLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy("password");
    setError(null);
    try {
      await post("/v1/auth/login", { username: username.trim(), password });
      window.location.href = "/";
    } catch (err) {
      setError((err as Error).message);
      setPassword("");
    } finally {
      setBusy(null);
    }
  };

  const walletLogin = async (w: WalletOption) => {
    setBusy(w.name);
    setError(null);
    try {
      await signIn(w);
      window.location.href = "/";
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <main className="login" lang="en">
      <div className="card">
        <div className="brand" style={{ justifyContent: "center" }}>
          <span className="brand-dot" /> Binflip
        </div>
        <h1>Sign in</h1>
        <form className="stack" onSubmit={passwordLogin} style={{ gap: 10 }}>
          <label className="field">Username
            <input type="text" name="username" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} required value={username} onChange={(e) => setUsername(e.target.value)} />
          </label>
          <label className="field">Password
            <input type="password" name="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <button className="btn btn-primary" type="submit" style={{ width: "100%", justifyContent: "center", height: 42 }} disabled={busy !== null || !username || !password}>
            {busy === "password" ? "Kontrol ediliyor…" : "Sign in"}
          </button>
        </form>
        {error && <p className="neg small" style={{ marginTop: 12 }}>{error}</p>}

        <div style={{ marginTop: 18 }}>
          <button className="btn btn-sm btn-ghost" type="button" onClick={() => setShowWallets(!showWallets)}>
            {showWallets ? "▾" : "▸"} Cüzdanla giriş
          </button>
          {showWallets && (
            <>
              {wallets.map((w) => (
                <button key={w.name} className="btn" style={{ width: "100%", justifyContent: "center", height: 40, marginTop: 8, gap: 8 }} onClick={() => walletLogin(w)} disabled={busy !== null}>
                  {w.icon && <img src={w.icon} alt="" width={20} height={20} style={{ borderRadius: 4 }} />}
                  {busy === w.name ? "Cüzdan bekleniyor…" : `${w.name} ile giriş`}
                </button>
              ))}
              {wallets.length === 0 && <p className="small muted" style={{ marginTop: 8 }}>Cüzdan bulunamadı. Cüzdan eklentisini kurup sayfayı yenile ya da adresi cüzdan uygulamasının tarayıcısından aç.</p>}
            </>
          )}
        </div>
        <p className="muted small" style={{ marginTop: 18 }}>Panel hiçbir zaman özel anahtar istemez. Her başarılı giriş Telegram'a bildirilir.</p>
      </div>
    </main>
  );
}
