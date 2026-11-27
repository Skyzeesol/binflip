export const short = (a: string | null | undefined, n = 4) => (a ? `${a.slice(0, n)}…${a.slice(-n)}` : "—");
export const solFmt = (v: number | null | undefined, d = 4) => (v === null || v === undefined ? "—" : `${v.toFixed(d)} SOL`);
export const signed = (v: number, d = 4) => `${v >= 0 ? "+" : ""}${v.toFixed(d)}`;
export function ago(iso: string | null): string {
  if (!iso) return "—";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)} sn önce`;
  if (s < 3600) return `${Math.floor(s / 60)} dk önce`;
  if (s < 86400) return `${Math.floor(s / 3600)} sa önce`;
  return `${Math.floor(s / 86400)} gün önce`;
}
export const time = (iso: string) => new Date(iso).toLocaleString("tr-TR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

/** Turkish labels for machine reasons (txs.reason). */
export const REASONS: Record<string, string> = {
  position_not_copied: "Kopyalanmamış pozisyon",
  meme_protection: "Meme koruması",
  strategy_not_copied: "Strateji ayarlarda yok",
  pool_type_not_copied: "Havuz tipi kopyalanmıyor",
  leader_paused: "Lider duraklatıldı",
  remove_unresolved: "Liderin çekimi okunamadı; tahmin edilmedi, çekim yapılmadı",
  remove_outside_copy: "Lider kopyada olmayan bin'lerden çekti",
  leader_position_gone: "Lider pozisyonu kapatmış; çıkış kapanış olayıyla yapılır",
  kill_switch: "Acil durdurma açık",
  fund_protection: "Zarar limiti doldu",
  unfunded_empty: "Fonlanmadı, kapatıldı",
  holding: "Smart Token Retention: tutuluyor",
  holding_sell_now: "Şimdi sat istendi",
  holding_early_sell: "Erken satış (koşul gerçekleşti)",
  retention_sold: "Tutma bitti, satıldı",
  reused_by_readd: "Lider geri ekledi, token yeniden kullanıldı",
  auto_paused_no_funds: "Fonsuz cüzdan: otomatik duraklatıldı",
  token_filter: "Token filtreyi geçemedi",
  token_blacklisted: "Token kara listede",
  closed_externally: "Dışarıdan kapatıldı",
  leader_exit: "Liderle çıkış",
  daily_limit: "Günlük limit doldu",
  copy_size_zero: "Kopya boyutu 0",
  no_sizing_rule: "Boyut kuralı yok",
  position_cap_reached: "Pozisyon üst sınırı",
  non_sol_pair: "SOL'süz havuz",
  low_balance: "Yetersiz bakiye",
  already_closed: "Zaten kapalı",
  rebalance_partial: "Kısmi rebalance",
  rebalance_topup: "Rebalance + ekleme",
  rebalance_take_profit: "Rebalance + kâr alma",
  rebalance_unknown: "Rebalance okunamadı",
  damm_live_not_supported: "DAMM V2 canlı desteklenmiyor",
  live_not_implemented: "Canlı icra yok",
  interrupted_needs_review: "Yarıda kaldı — kontrol edin",
  partial_needs_review: "Kısmen gönderildi — kontrol edin",
  send_failed: "Gönderilemedi",
  tokens_left_retrying: "Token satılamadı, tekrar deneniyor",
  no_tokens_left: "Satılacak token yok",
  profit_sweep: "Kâr süpürme",
  take_profit: "Take profit",
  stop_loss: "Stop loss",
  trailing_stop: "Trailing stop",
  staged_flip: "Staged Flip",
  bottom_flip: "Bottom Flip",
  back_flip: "Back Flip (flip öncesine dönüş)",
  rl_reshape: "Precision Hybrid reshape",
  auto_compound: "Auto-compound",
};
export const reasonTr = (r: string | null) => (r ? (REASONS[r] ?? r) : "—");

export const MODE_TR: Record<string, string> = {
  mirror: "Mirror only",
  staged_flip: "Staged Flip",
  bottom_flip: "Bottom Flip",
  precision_hybrid: "Precision Hybrid",
};
