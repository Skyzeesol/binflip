import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { QUEUES, runService, type NotificationJob } from "@binflip/core";
import { createDb } from "@binflip/db";

/**
 * telegram — delivers notifications. Without TELEGRAM_BOT_TOKEN it only logs
 * them, so the dry-run feed is visible in `docker compose logs telegram`.
 * Commands (/status /pause /stop) come with the bot token, after the panel.
 */
await runService("telegram", async ({ config, log }) => {
  const { ping, close } = createDb(config.DATABASE_URL, { max: 2 });
  const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  const token = config.TELEGRAM_BOT_TOKEN;
  const chatId = config.TELEGRAM_CHAT_ID;
  if (!token || !chatId) log.info("TELEGRAM_BOT_TOKEN/CHAT_ID not set: notifications are logged only");

  const worker = new Worker<NotificationJob>(
    QUEUES.NOTIFICATIONS,
    async (job) => {
      log.info({ notify: true }, job.data.text);
      if (!token || !chatId) return;
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
  return {
    checks: { postgres: ping, redis: async () => void (await connection.ping()) },
    cleanups: [() => close(), async () => void (await connection.quit()), () => worker.close()],
  };
});
