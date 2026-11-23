"use client";

import { useEffect, useState } from "react";
import { listWallets, onWalletsChanged, signIn, type WalletOption } from "@/lib/wallet";

export default function LoginPage() {
  const [wallets, setWallets] = useState<WalletOption[]>([]);
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

  const go = async (w: WalletOption) => {
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
    <main className="login">
      <div className="card">
        <div className="brand" style={{ justifyContent: "center" }}>
          <span className="brand-dot" /> Binflip
        </div>
        <h1>Panele giriş</h1>
        <p className="muted">Kayıtlı giriş cüzdanınızla bir mesaj imzalayın. Bu imza işlem yapmaz ve ücret ödemez.</p>
        {wallets.map((w) => (
          <button
            key={w.name}
            className="btn btn-primary"
            style={{ width: "100%", justifyContent: "center", height: 42, marginTop: 8, gap: 8 }}
            onClick={() => go(w)}
            disabled={busy !== null}
          >
            {w.icon && <img src={w.icon} alt="" width={20} height={20} style={{ borderRadius: 4 }} />}
            {busy === w.name ? "Cüzdan bekleniyor…" : `${w.name} ile giriş`}
          </button>
        ))}
        {wallets.length === 0 && (
          <p className="small" style={{ marginTop: 12 }}>
            Cüzdan bulunamadı. Bilgisayarda Jupiter, Phantom ya da Solflare eklentisini kurup sayfayı yenileyin. Telefonda bu adresi cüzdan
            uygulamasının içindeki tarayıcıdan açın (Jupiter: alttaki tarayıcı sekmesi).
          </p>
        )}
        {error && <p className="neg small" style={{ marginTop: 12 }}>{error}</p>}
        <p className="muted small" style={{ marginTop: 18 }}>Giriş cüzdanı, bot cüzdanından ayrıdır. Panel hiçbir zaman özel anahtar istemez.</p>
      </div>
    </main>
  );
}
