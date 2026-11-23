"use client";

import { useState } from "react";
import { signIn } from "@/lib/wallet";

export default function LoginPage() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await signIn();
      window.location.href = "/";
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
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
        <button className="btn btn-primary" style={{ width: "100%", justifyContent: "center", height: 42, marginTop: 8 }} onClick={go} disabled={busy}>
          {busy ? "Cüzdan bekleniyor…" : "Phantom / Solflare ile giriş"}
        </button>
        {error && <p className="neg small" style={{ marginTop: 12 }}>{error}</p>}
        <p className="muted small" style={{ marginTop: 18 }}>Giriş cüzdanı, bot cüzdanından ayrıdır. Panel hiçbir zaman özel anahtar istemez.</p>
      </div>
    </main>
  );
}
