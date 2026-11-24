import { randomUUID } from "node:crypto";
import type { Queue } from "bullmq";
import type { OpenJob } from "@binflip/core";

/**
 * Telegram "open a position" wizard (mode 2 of the bot, next to copying leaders):
 * the user sends a token CA (or a Meteora pool / link); for a token the bot lists
 * its SOL pools to pick from, then asks amount, how far below the price, strategy,
 * fees, management and TP/SL, and queues the open for the executor (agent wallet).
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

export interface TokenPool extends PoolInfo {
  address: string;
  feeTvl1h: number;
  volume24h: number;
}

type Step = "pool" | "amount" | "range" | "strategy" | "fees" | "manage" | "exits" | "confirm";
interface State {
  pool: string;
  info: PoolInfo;
  token?: { mint: string; symbol: string; pools: TokenPool[] };
  step: Step;
  amountSol?: number;
  lowerPct?: number;
  strategy?: "spot" | "curve" | "bid_ask";
  feeMode?: "compound" | "sell";
  managementMode?: "mirror" | "staged_flip" | "bottom_flip" | "precision_hybrid";
  flipPct?: number;
  reshapeBins?: number;
  /** undefined = Settings' Auto TP/SL; null = off. */
  exits?: { tp: number | null; sl: number | null } | null;
  at: number;
}

const ADDR = /[1-9A-HJ-NP-Za-km-z]{32,44}/;
const kb = (rows: Array<Array<[string, string]>>): Keyboard => ({ inline_keyboard: rows.map((r) => r.map(([text, data]) => ({ text, callback_data: data }))) });
const money = (v: number) => (v >= 1e6 ? `$${(v / 1e6).toFixed(2)}m` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}k` : `$${v.toFixed(0)}`);
const fee = (v: number) => String(Number(v.toFixed(2)));
const STRAT: Record<string, string> = { spot: "Spot", curve: "Curve", bid_ask: "Bid-Ask" };
const MODE: Record<string, string> = { staged_flip: "Kademeli flip", bottom_flip: "Dipte flip", precision_hybrid: "Precision Hybrid", mirror: "Sadece tut" };

export class OpenWizard {
  private states = new Map<string, State>();

  constructor(
    private readonly queue: Queue<OpenJob>,
    private readonly userId: () => Promise<string>,
    private readonly fetchPool: (address: string) => Promise<PoolInfo | null> = defaultFetchPool,
    private readonly fetchTokenPools: (mint: string) => Promise<{ symbol: string; pools: TokenPool[] }> = defaultFetchTokenPools,
  ) {}

  /** A message that may start the wizard (a pool address or Meteora link) or answer a typed question. */
  async onText(chatId: string, text: string): Promise<Reply | null> {
    this.gc();
    const t = text.trim();
    const s = this.states.get(chatId);
    const addr = t.match(ADDR)?.[0];
    // A bare address (token CA or pool), /ac <address>, or a link that carries one (Meteora, DexScreener, pump.fun, Jupiter…).
    if (addr && (t.startsWith("/ac") || t === addr || /^https?:\/\//.test(t))) return this.start(chatId, addr);
    if (t.startsWith("/ac")) return { text: "Kullanım: /ac <token CA ya da havuz adresi>. Sadece CA'yı göndermen de yeter." };
    if (!s) return null;
    const n = Number(t.replace(",", ".").replace("%", "").replace("-", ""));
    if (s.step === "amount" && n > 0) return this.answer(chatId, `amt:${n}`);
    if (s.step === "range" && n > 0 && n < 100) return this.answer(chatId, `rng:${n}`);
    if (s.step === "manage" && n >= 1 && n <= 90) return this.answer(chatId, `mng:staged_flip:${n}`);
    if (s.step === "pool" && Number.isInteger(n) && n >= 1 && n <= (s.token?.pools.length ?? 0)) return this.answer(chatId, `p:${n - 1}`);
    if (s.step === "exits") {
      const m = t.replace(/[%\s]/g, "").match(/^(\d+(?:[.,]\d+)?)\/(\d+(?:[.,]\d+)?)$/);
      if (m) return this.answer(chatId, `ex:${m[1]!.replace(",", ".")}:${m[2]!.replace(",", ".")}`);
    }
    return { text: "Bunu anlamadım. Butonlardan birini seç ya da sayı yaz. Vazgeçmek için /iptal." };
  }

  cancel(chatId: string): Reply {
    const had = this.states.delete(chatId);
    return { text: had ? "İptal edildi." : "Açık bir işlem yok." };
  }

  private async start(chatId: string, address: string): Promise<Reply> {
    const info = await this.fetchPool(address);
    if (!info) return this.startToken(chatId, address);
    return this.startPool(chatId, address, info);
  }

  /** A token CA: list its SOL pools on Meteora and let the user pick one. */
  private async startToken(chatId: string, mint: string): Promise<Reply> {
    const r = await this.fetchTokenPools(mint).catch(() => ({ symbol: "", pools: [] as TokenPool[] }));
    if (!r.pools.length) return { text: "Bu adres için SOL'lü bir Meteora havuzu bulamadım (ne havuz ne de havuzu olan bir token). CA'yı kontrol et." };
    // Dust pools (< $500) only if nothing else exists; the star needs real liquidity too.
    const real = r.pools.filter((p) => p.tvl >= 500);
    const pools = (real.length ? real : r.pools).slice(0, 6);
    this.states.set(chatId, { pool: "", info: pools[0]!, token: { mint, symbol: r.symbol, pools }, step: "pool", at: Date.now() });
    const starOk = (p: TokenPool) => p.tvl >= 1000;
    const best = pools.reduce((b, p, i) => (starOk(p) && (!starOk(pools[b]!) || p.feeTvl24h > pools[b]!.feeTvl24h) ? i : b), 0);
    const lines = pools.map((p, i) => `${i + 1}) ${p.protocol === "dlmm" ? `DLMM bin ${p.binStep}` : "DAMM V2"} · fee ${fee(p.baseFee)}% · TVL ${money(p.tvl)} · hacim 24s ${money(p.volume24h)} · Fee/TVL 24s %${p.feeTvl24h.toFixed(2)}${i === best ? " ⭐" : ""}`);
    return {
      text: `🪙 ${r.symbol || mint.slice(0, 6)} için ${pools.length} SOL havuzu buldum:\n\n${lines.join("\n")}\n\nHangi havuz? (⭐ = en yüksek Fee/TVL; numarasını da yazabilirsin)`,
      keyboard: kb([...pools.map((p, i) => [[`${i + 1}) ${p.protocol === "dlmm" ? `bin ${p.binStep}` : "DAMM V2"} · ${fee(p.baseFee)}% · ${money(p.tvl)}${i === best ? " ⭐" : ""}`, `p:${i}`] as [string, string]]), [["İptal", "x"]]]),
    };
  }

  private async startPool(chatId: string, pool: string, info: PoolInfo): Promise<Reply> {
    if (!info.hasSol) return { text: `${info.name}: bu havuzda SOL yok. Bot SOL ile açar; Token/SOL havuzu gönder.` };
    if (info.protocol === "dlmm" && !info.solIsY) return { text: `${info.name}: SOL'ün X tarafında olduğu havuzlar henüz desteklenmiyor. Token/SOL havuzu gönder.` };
    this.states.set(chatId, { pool, info, step: "amount", at: Date.now() });
    const head = `🏊 ${info.name} · ${info.protocol === "dlmm" ? `DLMM bin ${info.binStep}` : "DAMM V2"} · fee ${fee(info.baseFee)}%\nTVL ${money(info.tvl)} · Fee/TVL 24s %${info.feeTvl24h.toFixed(2)}`;
    return {
      text: `${head}\n\n1) Kaç SOL koyalım? (butona bas ya da sayı yaz)`,
      keyboard: kb([[["0.1", "amt:0.1"], ["0.5", "amt:0.5"], ["1", "amt:1"]], [["2", "amt:2"], ["5", "amt:5"], ["İptal", "x"]]]),
    };
  }

  /** A button press (or a typed answer mapped to the same data). */
  async answer(chatId: string, data: string): Promise<Reply> {
    const s = this.states.get(chatId);
    if (data === "x") return this.cancel(chatId);
    if (!s) return { text: "Bu işlemin süresi doldu. CA'yı ya da havuz adresini tekrar gönder." };
    s.at = Date.now();
    const [k, a, b] = data.split(":");

    if (k === "p") {
      const picked = s.token?.pools[Number(a)];
      if (s.step !== "pool" || !picked) return { text: "Bu seçim artık geçerli değil. CA'yı tekrar gönder." };
      return this.startPool(chatId, picked.address, picked);
    }
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
        return this.askExits(s);
      }
      s.step = "manage";
      return {
        text: `5) Nasıl yönetelim? (kademeli flip eşiğini sayı olarak da yazabilirsin, ör. 14)`,
        keyboard: kb([[["Kademeli flip %10", "mng:staged_flip:10"], ["Kademeli flip %14", "mng:staged_flip:14"]], [["Dipte flip", "mng:bottom_flip"], ["Sadece tut", "mng:mirror"]], [["Precision Hybrid (12 bin)", "mng:precision_hybrid:12"]], [["İptal", "x"]]]),
      };
    }
    if (k === "mng") {
      s.managementMode = a as State["managementMode"];
      s.flipPct = a === "staged_flip" ? Number(b ?? 10) : undefined;
      s.reshapeBins = a === "precision_hybrid" ? Math.min(51, Math.max(1, Number(b ?? 12))) : undefined;
      return this.askExits(s);
    }
    if (k === "ex") {
      if (a === "def") s.exits = undefined;
      else if (a === "off") s.exits = null;
      else {
        const tp = Number(a), sl = Number(b);
        if (!(tp > 0 && tp <= 10_000 && sl > 0 && sl <= 100)) return { text: "TP 0'dan büyük, SL 1–100 arası olmalı. Ör. 15/10" };
        s.exits = { tp, sl };
      }
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
        ...(s.reshapeBins ? { reshapeBins: s.reshapeBins } : {}),
        feeMode: s.feeMode ?? "compound",
        compoundMinutes: 60,
        // Left out = the executor applies Settings → Auto TP/SL.
        ...(s.exits === undefined ? {} : s.exits === null ? { takeProfitBps: null, stopLossBps: null } : { takeProfitBps: Math.round(s.exits.tp! * 100), stopLossBps: Math.round(s.exits.sl! * 100) }),
        chatId,
      };
      await this.queue.add("open", job, { jobId: `open_${job.requestId}`, attempts: 1, removeOnComplete: { age: 86_400 } });
      this.states.delete(chatId);
      return { text: `⏳ Gönderildi: ${s.info.name} için ${s.amountSol} SOL. Açılınca haber vereceğim.` };
    }
    return { text: "Bilinmeyen seçim." };
  }

  private askExits(s: State): Reply {
    s.step = "exits";
    return {
      text: `${s.info.protocol === "dlmm" ? "6" : "5"}) TP / SL? (ör. 15/10 yazabilirsin: TP %15, SL %10)`,
      keyboard: kb([[["Ayarlar'daki varsayılan", "ex:def"]], [["TP %10 · SL %10", "ex:10:10"], ["TP %20 · SL %15", "ex:20:15"]], [["Kapalı", "ex:off"], ["İptal", "x"]]]),
    };
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
      dlmm ? `• Yönetim: ${MODE[s.managementMode ?? "staged_flip"]}${s.flipPct ? ` (eşik %${s.flipPct})` : ""}${s.reshapeBins ? ` (${s.reshapeBins} bin'de reshape)` : ""}` : null,
      `• TP / SL: ${s.exits === undefined ? "Ayarlar'daki Auto TP/SL" : s.exits === null ? "kapalı" : `TP %${s.exits.tp} · SL %${s.exits.sl}`}`,
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

/** SOL pools of a token on Meteora DLMM (SOL as Y) and DAMM V2, biggest first. */
async function defaultFetchTokenPools(mint: string): Promise<{ symbol: string; pools: TokenPool[] }> {
  const sol = "So11111111111111111111111111111111111111112";
  const out: TokenPool[] = [];
  let symbol = "";
  for (const [protocol, base] of [
    ["dlmm", "https://dlmm.datapi.meteora.ag"],
    ["damm_v2", "https://damm-v2.datapi.meteora.ag"],
  ] as const) {
    try {
      const qs = new URLSearchParams({ page: "1", page_size: "30", sort_by: "tvl:desc", query: mint });
      const res = await fetch(`${base}/pools?${qs}`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) continue;
      const body = (await res.json()) as { data?: Array<Record<string, any>> };
      for (const p of body.data ?? []) {
        const x = p.token_x?.address, y = p.token_y?.address;
        if (!((x === mint && y === sol) || (protocol === "damm_v2" && x === sol && y === mint))) continue;
        if (Number(p.tvl ?? 0) <= 0) continue;
        symbol ||= String((x === mint ? p.token_x : p.token_y)?.symbol ?? "");
        out.push({
          address: String(p.address),
          protocol,
          name: `${p.token_x?.symbol ?? "?"}/${p.token_y?.symbol ?? "?"}`,
          tvl: Number(p.tvl ?? 0),
          feeTvl24h: Number(p.fee_tvl_ratio?.["24h"] ?? 0),
          feeTvl1h: Number(p.fee_tvl_ratio?.["1h"] ?? 0),
          volume24h: Number(p.volume?.["24h"] ?? 0),
          binStep: p.pool_config?.bin_step ?? null,
          baseFee: Number(p.pool_config?.base_fee_pct ?? 0),
          solIsY: y === sol,
          hasSol: true,
        });
      }
    } catch {
      /* try the next protocol */
    }
  }
  return { symbol, pools: out.sort((a, b) => b.tvl - a.tvl) };
}
