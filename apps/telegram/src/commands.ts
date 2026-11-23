import { and, eq, gte, sql } from "drizzle-orm";
import type { Logger } from "@binflip/core";
import { schema, type DbHandle } from "@binflip/db";

type Db = DbHandle["db"];

interface Update {
  update_id: number;
  message?: { chat: { id: number }; text?: string };
}

const HELP = [
  "Binflip komutları:",
  "/durum: botun durumu, açık pozisyonlar, son 24 saat",
  "/stop: ACİL DURDUR (yeni açma/ekleme durur, çıkışlar liderle devam eder)",
  "/devam: acil durdurmayı kaldır",
  "/yardim: bu liste",
].join("\n");

/**
 * Long-polls Telegram for commands. Only the configured chat is obeyed;
 * everything else is ignored silently (anyone can message a bot).
 */
export class CommandPoller {
  private offset = 0;
  private stopped = false;

  constructor(
    private readonly token: string,
    private readonly chatId: string,
    private readonly db: Db,
    private readonly log: Logger,
  ) {}

  start() {
    void this.loop();
  }

  stop() {
    this.stopped = true;
  }

  private async loop() {
    while (!this.stopped) {
      try {
        const res = await fetch(`https://api.telegram.org/bot${this.token}/getUpdates`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ offset: this.offset, timeout: 25, allowed_updates: ["message"] }),
          signal: AbortSignal.timeout(35_000),
        });
        const body = (await res.json()) as { ok: boolean; result?: Update[] };
        for (const u of body.result ?? []) {
          this.offset = u.update_id + 1;
          await this.handle(u).catch((e) => this.log.warn({ err: (e as Error).message }, "command failed"));
        }
        if (!body.ok) await sleep(5_000);
      } catch (e) {
        this.log.warn({ err: (e as Error).message }, "telegram poll failed");
        await sleep(5_000);
      }
    }
  }

  private async handle(u: Update) {
    const msg = u.message;
    if (!msg?.text || String(msg.chat.id) !== this.chatId) return;
    const cmd = msg.text.trim().split(/\s+/)[0]!.toLowerCase().replace(/@.*$/, "");
    let reply: string;
    switch (cmd) {
      case "/durum":
      case "/status":
        reply = await this.status();
        break;
      case "/stop":
        reply = await this.setKill(true);
        break;
      case "/devam":
      case "/resume":
        reply = await this.setKill(false);
        break;
      default:
        reply = HELP;
    }
    this.log.info({ cmd }, "telegram command");
    await this.send(reply);
  }

  private async owner() {
    const [u] = await this.db.select().from(schema.users).where(eq(schema.users.role, "owner"));
    if (!u) throw new Error("no owner user");
    return u;
  }

  private async setKill(on: boolean): Promise<string> {
    const u = await this.owner();
    await this.db
      .update(schema.userRiskSettings)
      .set({ killSwitch: on, killSwitchReason: on ? "telegram" : null })
      .where(eq(schema.userRiskSettings.userId, u.id));
    return on
      ? "⛔ ACİL DURDURMA AÇIK. Yeni pozisyon açılmayacak, ekleme yapılmayacak. Açık kopyalar liderle birlikte çıkmaya devam eder. Kaldırmak için /devam"
      : "✅ Acil durdurma kaldırıldı. Kopyalama devam ediyor.";
  }

  private async status(): Promise<string> {
    const u = await this.owner();
    const [risk] = await this.db.select().from(schema.userRiskSettings).where(eq(schema.userRiskSettings.userId, u.id));
    const leaders = await this.db
      .select({ status: schema.leaders.status, n: sql<number>`count(*)::int` })
      .from(schema.leaders)
      .where(eq(schema.leaders.userId, u.id))
      .groupBy(schema.leaders.status);
    const [pos] = await this.db
      .select({
        n: sql<number>`count(*)::int`,
        deposited: sql<string>`coalesce(sum(${schema.positions.depositedSol}), 0)::text`,
        value: sql<string>`coalesce(sum(${schema.positions.currentValueSol}), 0)::text`,
      })
      .from(schema.positions)
      .where(and(eq(schema.positions.userId, u.id), sql`${schema.positions.state} not in ('CLOSED')`));
    const since = new Date(Date.now() - 24 * 3600_000);
    const day = await this.db
      .select({ status: schema.txs.status, n: sql<number>`count(*)::int` })
      .from(schema.txs)
      .where(and(eq(schema.txs.userId, u.id), gte(schema.txs.createdAt, since)))
      .groupBy(schema.txs.status);
    const [last] = await this.db
      .select({ dryRun: schema.txs.dryRun })
      .from(schema.txs)
      .where(eq(schema.txs.userId, u.id))
      .orderBy(sql`${schema.txs.createdAt} desc`)
      .limit(1);

    const count = (rows: { status: string; n: number }[], s: string) => rows.find((r) => r.status === s)?.n ?? 0;
    const deposited = Number(pos?.deposited ?? 0) / 1e9;
    const value = Number(pos?.value ?? 0);
    const pnl = value - deposited;
    const lines = [
      `📊 Binflip durumu`,
      `Mod: ${last ? (last.dryRun ? "DENEME" : "CANLI") : "henüz işlem yok"}`,
      `Acil durdurma: ${risk?.killSwitch ? `AÇIK (${risk.killSwitchReason ?? "-"})` : "kapalı"}`,
      `Fon koruması: ${risk?.fundProtectionTrippedAt ? "TETİKLENDİ" : "normal"}`,
      `Liderler: ${count(leaders, "active")} aktif, ${count(leaders, "paused")} duraklatılmış`,
      `Açık pozisyon: ${pos?.n ?? 0} · yatırılan ${deposited.toFixed(3)} SOL · güncel ${value.toFixed(3)} SOL · PnL ${pnl >= 0 ? "+" : ""}${pnl.toFixed(3)} SOL (tahmini)`,
      `Son 24 saat: ${day.reduce((a, r) => a + r.n, 0)} kayıt (onaylanan ${count(day, "confirmed")}, planlanan ${count(day, "planned")}, atlanan ${count(day, "skipped")}, başarısız ${count(day, "failed")})`,
    ];
    return lines.join("\n");
  }

  private async send(text: string) {
    await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: this.chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
