import { Redis } from "ioredis";
import { runService } from "@binflip/core";
import { createDb } from "@binflip/db";

/**
 * telegram — notifications and /status /pause /stop commands (stage 2).
 * Stage 1: skeleton only. Connects to Postgres and Redis and reports health.
 */
await runService("telegram", async ({ config, log }) => {
  const db = createDb(config.DATABASE_URL, { max: 5 });
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });
  redis.on("error", (err) => log.warn({ err: err.message }, "redis error"));
  await redis.connect();
  await db.ping();

  return {
    checks: {
      postgres: () => db.ping(),
      redis: async () => {
        await redis.ping();
      },
    },
    cleanups: [() => db.close(), async () => void (await redis.quit())],
  };
});
