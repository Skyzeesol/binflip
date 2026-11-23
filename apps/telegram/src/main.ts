import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { QUEUES, runService, type NotificationJob, type OpenJob } from "@binflip/core";
import { createDb } from "@binflip/db";
import { CommandPoller } from "./commands.js";
import { OpenWizard } from "./wizard.js";
import { eq } from "drizzle-orm";
import { schema } from "@binflip/db";

/**
 * telegram — delivers notifications. Without TELEGRAM_BOT_TOKEN it only logs
 * them, so the dry-run feed is visible in `docker compose logs telegram`.
 * With the token, commands from the configured chat only: /durum /stop /devam /yardim.
 */
await runService("telegram", async ({ config, log }) => {
  const { db, ping, close } = createDb(config.DATABASE_URL, { max: 2 });
  const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  const token = config.TELEGRAM_BOT_TOKEN;
  const chatId = config.TELEGRAM_CHAT_ID;
  if (!token || !chatId) log.info("TELEGRAM_BOT_TOKEN/CHAT_ID not set: notifications are logged only");

  // Settings → Bildirimler: kinds the user turned off are not sent (cached 30 s).
  const prefCache = new Map<string, { at: number; notify: Record<string, boolean> }>();
  const muted = async (userId: string, kind: string) => {
    let c = prefCache.get(userId);
    if (!c || Date.now() - c.at > 30_000) {
      const [u] = await db.select({ prefs: schema.users.prefs }).from(schema.users).where(eq(schema.users.id, userId));
      c = { at: Date.now(), notify: ((u?.prefs ?? {}) as { notify?: Record<string, boolean> }).notify ?? {} };
      prefCache.set(userId, c);
    }
    return c.notify[kind] === false;
  };
  const worker = new Worker<NotificationJob>(
    QUEUES.NOTIFICATIONS,
    async (job) => {
      log.info({ notify: true, kind: job.data.kind }, job.data.text);
      if (!token || !chatId) return;
      if (job.data.kind && (await muted(job.data.userId, job.data.kind))) return { muted: true };
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: job.data.text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`telegram HTTP ${res.status}`); // retried by BullMQ
    },
    { connection, concurrency: 1, limiter: { max: 20, duration: 60_000 } },
  );
  worker.on("failed", (job, err) => log.warn({ err: err.message, attempts: job?.attemptsMade }, "notification failed"));

  await ping();
  const openQueue = new Queue<OpenJob>(QUEUES.OPEN, { connection });
  const ownerId = async () => {
    const [u] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.role, "owner"));
    if (!u) throw new Error("no owner user");
    return u.id;
  };
  const wizard = new OpenWizard(openQueue, ownerId);
  const commands = token && chatId ? new CommandPoller(token, chatId, db, log, wizard) : null;
  commands?.start();
  return {
    checks: { postgres: ping, redis: async () => void (await connection.ping()) },
    cleanups: [async () => commands?.stop(), () => openQueue.close(), () => close(), async () => void (await connection.quit()), () => worker.close()],
  };
});
