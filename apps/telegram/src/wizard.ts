import { randomUUID } from "node:crypto";
import type { Queue } from "bullmq";
import type { OpenJob } from "@binflip/core";

/**
 * Telegram "open a position" wizard (mode 2 of the bot, next to copying leaders):
 * the user sends a Meteora pool (address or app.meteora.ag link); the bot asks
 * amount, how far below the price, strategy, what to do with fees and how to
 * manage it, then queues the open for the executor (agent wallet).
 */

export interface Keyboard {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}
export interface Reply {
  text: string;
  keyboard?: Keyboard;
}

interface PoolInfo {
  protocol: "dlmm" | "damm_v2";
  name: string;
  tvl: number;
  feeTvl24h: number;
  binStep: number | null;
  baseFee: number;
  solIsY: boolean;
  hasSol: boolean;
}

type Step = "amount" | "range" | "strategy" | "fees" | "manage" | "confirm";
interface State {
  pool: string;
  info: PoolInfo;
  step: Step;
  amountSol?: number;
  lowerPct?: number;
  strategy?: "spot" | "curve" | "bid_ask";
  feeMode?: "compound" | "sell";
  managementMode?: "mirror" | "staged_flip" | "bottom_flip";
  flipPct?: number;
  at: number;
}

const ADDR = /[1-9A-HJ-NP-Za-km-z]{32,44}/;
const kb = (rows: Array<Array<[string, string]>>): Keyboard => ({ inline_keyboard: rows.map((r) => r.map(([text, data]) => ({ text, callback_data: data }))) });
const money = (v: number) => (v >= 1e6 ? `$${(v / 1e6).toFixed(2)}m` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}k` : `$${v.toFixed(0)}`);
const STRAT: Record<string, string> = { spot: "Spot", curve: "Curve", bid_ask: "Bid-Ask" };
const MODE: Record<string, string> = { staged_flip: "Kademeli flip", bottom_flip: "Dipte flip", mirror: "Sadece tut" };

export class OpenWizard {
  private states = new Map<string, State>();

  constructor(
    private readonly queue: Queue<OpenJob>,
    private readonly userId: () => Promise<string>,
    private readonly fetchPool: (address: string) => Promise<PoolInfo | null> = defaultFetchPool,
  ) {}

  /** A message that may start the wizard (a pool address or Meteora link) or answer a typed question. */
  async onText(chatId: string, text: string): Promise<Reply | null> {
    this.gc();
    const t = text.trim();
    const s = this.states.get(chatId);
    const addr = t.match(ADDR)?.[0];
    if (addr && (t.startsWith("/ac") || t.includes("meteora.ag") || t === addr)) return this.start(chatId, addr);
    if (t.startsWith("/ac")) return { text: "Kullanım: /ac <havuz adresi> ya da sadece havuz adresini / Meteora linkini gönder." };
    if (!s) return null;
    const n = Number(t.replace(",", ".").replace("%", "").replace("-", ""));
    if (s.step === "amount" && n > 0) return this.answer(chatId, `amt:${n}`);
    if (s.step === "range" && n > 0 && n < 100) return this.answer(chatId, `rng:${n}`);
    if (s.step === "manage" && n >= 1 && n <= 90) return this.answer(chatId, `mng:staged_flip:${n}`);
    return { text: "Bunu anlamadım. Butonlardan birini seç ya da sayı yaz. Vazgeçmek için /iptal." };
  }

  cancel(chatId: string): Reply {
    const had = this.states.delete(chatId);
    return { text: had ? "İptal edildi." : "Açık bir işlem yok." };
  }

  private async start(chatId: string, pool: string): Promise<Reply> {
    const info = await this.fetchPool(pool);
    if (!info) return { text: "Bu adreste bir Meteora DLMM ya da DAMM V2 havuzu bulamadım." };
    if (!info.hasSol) return { text: `${info.name}: bu havuzda SOL yok. Bot SOL ile açar; Token/SOL havuzu gönder.` };
    if (info.protocol === "dlmm" && !info.solIsY) return { text: `${info.name}: SOL'ün X tarafında olduğu havuzlar henüz desteklenmiyor. Token/SOL havuzu gönder.` };
    this.states.set(chatId, { pool, info, step: "amount", at: Date.now() });
    const head = `🏊 ${info.name} · ${info.protocol === "dlmm" ? `DLMM bin ${info.binStep}` : "DAMM V2"} · fee ${info.baseFee}%\nTVL ${money(info.tvl)} · Fee/TVL 24s %${info.feeTvl24h.toFixed(2)}`;
    return {
      text: `${head}\n\n1) Kaç SOL koyalım? (butona bas ya da sayı yaz)`,
      keyboard: kb([[["0.1", "amt:0.1"], ["0.5", "amt:0.5"], ["1", "amt:1"]], [["2", "amt:2"], ["5", "amt:5"], ["İptal", "x"]]]),
    };
  }

  /** A button press (or a typed answer mapped to the same data). */
  async answer(chatId: string, data: string): Promise<Reply> {
    const s = this.states.get(chatId);
    if (data === "x") return this.cancel(chatId);
    if (!s) return { text: "Bu işlemin süresi doldu. Havuz adresini tekrar gönder." };
    s.at = Date.now();
    const [k, a, b] = data.split(":");
    const dlmm = s.info.protocol === "dlmm";

    if (k === "amt") {
      const v = Number(a);
      if (!(v > 0) || v > 10_000) return { text: "Geçerli bir SOL miktarı yaz." };
      s.amountSol = v;
      if (!dlmm) {
        s.step = "fees";
        return this.askFees();
      }
      s.step = "range";
      return {
        text: `2) Fiyatın yüzde kaç altına kadar? (aralık şu anki fiyattan aşağı, sadece SOL; sayı da yazabilirsin, ör. 40)`,
        keyboard: kb([[["-10%", "rng:10"], ["-30%", "rng:30"], ["-50%", "rng:50"], ["-70%", "rng:70"]], [["İptal", "x"]]]),
      };
    }
    if (k === "rng") {
      const v = Number(a);
      if (!(v > 0 && v < 100)) return { text: "1 ile 99 arasında bir yüzde yaz." };
      s.lowerPct = -v;
      s.step = "strategy";
      return { text: `3) Strateji?`, keyboard: kb([[["Bid-Ask", "str:bid_ask"], ["Spot", "str:spot"], ["Curve", "str:curve"]], [["İptal", "x"]]]) };
    }
    if (k === "str") {
      s.strategy = a as State["strategy"];
      s.step = "fees";
      return this.askFees();
    }
    if (k === "fee") {
      s.feeMode = a as State["feeMode"];
      if (!dlmm) {
        s.managementMode = "mirror";
        s.step = "confirm";
        return this.summary(s);
      }
      s.step = "manage";
      return {
        text: `5) Nasıl yönetelim? (kademeli flip eşiğini sayı olarak da yazabilirsin, ör. 14)`,
        keyboard: kb([[["Kademeli flip %10", "mng:staged_flip:10"], ["Kademeli flip %14", "mng:staged_flip:14"]], [["Dipte flip", "mng:bottom_flip"], ["Sadece tut", "mng:mirror"]], [["İptal", "x"]]]),
      };
    }
    if (k === "mng") {
      s.managementMode = a as State["managementMode"];
      s.flipPct = a === "staged_flip" ? Number(b ?? 10) : undefined;
      s.step = "confirm";
      return this.summary(s);
    }
    if (k === "ok") {
      if (s.step !== "confirm") return { text: "Önce soruları tamamla." };
      const userId = await this.userId();
      const job: OpenJob = {
        userId,
        requestId: randomUUID(),
        origin: "telegram",
        protocol: s.info.protocol,
        pool: s.pool,
        lamports: String(Math.round(s.amountSol! * 1e9)),
        lowerPct: s.lowerPct ?? -50,
        upperPct: 0,
        strategy: s.strategy ?? "bid_ask",
        managementMode: s.managementMode ?? "staged_flip",
        ...(s.flipPct ? { flipThresholdBps: Math.round(s.flipPct * 100) } : {}),
        feeMode: s.feeMode ?? "compound",
        compoundMinutes: 60,
        chatId,
      };
      await this.queue.add("open", job, { jobId: `open_${job.requestId}`, attempts: 1, removeOnComplete: { age: 86_400 } });
      this.states.delete(chatId);
      return { text: `⏳ Gönderildi: ${s.info.name} için ${s.amountSol} SOL. Açılınca haber vereceğim.` };
    }
    return { text: "Bilinmeyen seçim." };
  }

  private askFees(): Reply {
    return {
      text: `4) Fee'ler ne olsun?`,
      keyboard: kb([[["Auto-compound (pozisyona geri ekle)", "fee:compound"]], [["Sürekli SOL'e sat", "fee:sell"]], [["İptal", "x"]]]),
    };
  }

  private summary(s: State): Reply {
    const dlmm = s.info.protocol === "dlmm";
    const lines = [
      `📝 Özet: ${s.info.name}`,
      `• Miktar: ${s.amountSol} SOL`,
      dlmm ? `• Aralık: fiyattan %${-(s.lowerPct ?? -50)} aşağıya kadar (sadece SOL)` : "• DAMM V2: SOL'ün yarısı token'a çevrilip eklenir",
      dlmm ? `• Strateji: ${STRAT[s.strategy ?? "bid_ask"]}` : null,
      `• Fee'ler: ${s.feeMode === "sell" ? "sürekli SOL'e satılır" : "auto-compound"} (60 dk'da bir, eşik aşılınca)`,
      dlmm ? `• Yönetim: ${MODE[s.managementMode ?? "staged_flip"]}${s.flipPct ? ` (eşik %${s.flipPct})` : ""}` : null,
      "",
      "Bot cüzdanından açılır. Onaylıyor musun?",
    ].filter((l) => l !== null);
    return { text: lines.join("\n"), keyboard: kb([[["✅ Onayla ve aç", "ok"], ["İptal", "x"]]]) };
  }

  private gc() {
    const now = Date.now();
    for (const [k, v] of this.states) if (now - v.at > 15 * 60_000) this.states.delete(k);
  }
}

async function defaultFetchPool(address: string): Promise<PoolInfo | null> {
  const sol = "So11111111111111111111111111111111111111112";
  for (const [protocol, base] of [
    ["dlmm", "https://dlmm.datapi.meteora.ag"],
    ["damm_v2", "https://damm-v2.datapi.meteora.ag"],
  ] as const) {
    try {
      const res = await fetch(`${base}/pools/${address}`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) continue;
      const p = (await res.json()) as Record<string, any>;
      if (!p.address) continue;
      const solIsY = p.token_y?.address === sol;
      const hasSol = solIsY || p.token_x?.address === sol;
      if (!hasSol) return { protocol, name: String(p.name), tvl: 0, feeTvl24h: 0, binStep: null, baseFee: 0, solIsY: false, hasSol: false };
      return {
        protocol,
        name: `${p.token_x?.symbol ?? "?"}/${p.token_y?.symbol ?? "?"}`,
        tvl: Number(p.tvl ?? 0),
        feeTvl24h: Number(p.fee_tvl_ratio?.["24h"] ?? 0),
        binStep: p.pool_config?.bin_step ?? null,
        baseFee: Number(p.pool_config?.base_fee_pct ?? 0),
        solIsY,
        hasSol: true,
      };
    } catch {
      /* try the next protocol */
    }
  }
  return null;
}
