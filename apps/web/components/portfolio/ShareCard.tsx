"use client";

import { useEffect, useRef, useState } from "react";
import type { PfPosition } from "@/lib/types";

/**
 * LP Agent "Share your results": a PnL card for one position, drawn on a canvas,
 * downloaded as PNG or handed to the phone's share sheet.
 */
export function ShareCard({ p, onClose }: { p: PfPosition; onClose: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const W = 1200, H = 630;
    c.width = W;
    c.height = H;
    const g = c.getContext("2d")!;
    const up = (p.pnl ?? 0) >= 0;
    const bg = g.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, "#0c0c0e");
    bg.addColorStop(1, up ? "#0f2a1a" : "#2d1414");
    g.fillStyle = bg;
    g.fillRect(0, 0, W, H);
    // Brand
    g.fillStyle = "#8d84ff";
    g.save();
    g.translate(78, 78);
    g.rotate(Math.PI / 4);
    g.fillRect(-11, -11, 22, 22);
    g.restore();
    g.fillStyle = "#ececef";
    g.font = "700 40px system-ui, sans-serif";
    g.fillText("Binflip", 108, 92);
    g.fillStyle = "#8b8b94";
    g.font = "500 26px system-ui, sans-serif";
    g.fillText(p.closedAt ? "Kapanan pozisyon" : "Açık pozisyon", W - 330, 90);
    // Pair
    const sym = p.token?.symbol ?? "TOKEN";
    g.fillStyle = "#ececef";
    g.font = "700 64px system-ui, sans-serif";
    g.fillText(`${sym} / SOL`, 70, 220);
    g.fillStyle = "#8fb2ff";
    g.font = "600 28px system-ui, sans-serif";
    g.fillText(`${p.protocol === "dlmm" ? "Meteora DLMM" : "Meteora DAMM V2"}${p.strategy ? ` · ${p.strategy === "bid_ask" ? "Bid-Ask" : p.strategy[0]!.toUpperCase() + p.strategy.slice(1)}` : ""}${p.flips ? ` · ${p.flips} flip` : ""}`, 70, 266);
    // PnL
    g.fillStyle = up ? "#22c55e" : "#f05252";
    g.font = "800 150px system-ui, sans-serif";
    const pct = p.pnlPct ?? 0;
    g.fillText(`${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`, 62, 430);
    g.font = "700 48px system-ui, sans-serif";
    g.fillText(`${(p.pnl ?? 0) >= 0 ? "+" : ""}${(p.pnl ?? 0).toFixed(4)} SOL`, 70, 500);
    // Stats
    const stats: Array<[string, string]> = [
      ["Yatırılan", `${p.invested.toFixed(3)} SOL`],
      ["Fee", `${p.totalFee.toFixed(4)} SOL`],
      ["Süre", p.ageMs === null ? "—" : p.ageMs < 48 * 3_600_000 ? `${(p.ageMs / 3_600_000).toFixed(1)} sa` : `${(p.ageMs / 86_400_000).toFixed(1)} g`],
    ];
    stats.forEach(([k, v], i) => {
      const x = 70 + i * 300;
      g.fillStyle = "#8b8b94";
      g.font = "500 24px system-ui, sans-serif";
      g.fillText(k, x, 568);
      g.fillStyle = "#ececef";
      g.font = "700 32px system-ui, sans-serif";
      g.fillText(v, x, 606);
    });
    setUrl(c.toDataURL("image/png"));
  }, [p]);

  const name = `binflip-${p.token?.symbol ?? "pnl"}-${p.id.slice(0, 6)}.png`;
  const share = async () => {
    if (!url) return;
    const blob = await (await fetch(url)).blob();
    const file = new File([blob], name, { type: "image/png" });
    const nav = navigator as Navigator & { canShare?: (d: unknown) => boolean };
    if (nav.share && nav.canShare?.({ files: [file] })) await nav.share({ files: [file], title: "Binflip PnL" }).catch(() => undefined);
    else download();
  };
  const download = () => {
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-wide" role="dialog" aria-modal="true">
        <div className="modal-head">
          <div className="modal-title">PnL kartı</div>
          <button className="btn btn-sm btn-ghost" onClick={onClose} aria-label="Kapat">✕</button>
        </div>
        <div className="modal-body stack">
          <canvas ref={ref} style={{ width: "100%", height: "auto", borderRadius: 12 }} />
          <div className="pop-foot">
            <button className="btn" onClick={download}>PNG indir</button>
            <button className="btn btn-primary" onClick={share}>Paylaş</button>
          </div>
        </div>
      </div>
    </div>
  );
}
