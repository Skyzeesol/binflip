import Fastify from "fastify";
import { Redis } from "ioredis";
import { runService } from "@binflip/core";
import { createDb } from "@binflip/db";

/**
 * api — HTTP backend for the Copy LP panel (stage 5).
 * Stage 1: /health and /v1/status only.
 */
await runService("api", async ({ config, log }) => {
  const db = createDb(config.DATABASE_URL, { max: 5 });
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });
  redis.on("error", (err) => log.warn({ err: err.message }, "redis error"));
  await redis.connect();

  const app = Fastify({ loggerInstance: log, disableRequestLogging: true });

  app.get("/health", async (_req, reply) => {
    const checks: Record<string, string> = {};
    let ok = true;
    for (const [name, fn] of [
      ["postgres", () => db.ping()],
      ["redis", async () => void (await redis.ping())],
    ] as const) {
      try {
        await fn();
        checks[name] = "ok";
      } catch (err) {
        ok = false;
        checks[name] = err instanceof Error ? err.message : "error";
      }
    }
    return reply.code(ok ? 200 : 503).send({ status: ok ? "ok" : "degraded", checks });
  });

  app.get("/v1/status", async () => ({
    service: "binflip-api",
    version: process.env.npm_package_version ?? "0.1.0",
    mode: config.mode,
  }));

  await app.listen({ host: "0.0.0.0", port: config.API_PORT });

  return {
    noHealthServer: true,
    cleanups: [() => db.close(), async () => void (await redis.quit()), () => app.close()],
  };
});
