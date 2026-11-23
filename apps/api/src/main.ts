import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { Redis } from "ioredis";
import { ConfigError, runService } from "@binflip/core";
import { createDb } from "@binflip/db";
import { registerRoutes } from "./routes.js";

/**
 * api — backend for the Copy LP panel. Session = wallet signature (SIWS),
 * HMAC-signed cookie. Listens on localhost; put a TLS reverse proxy in front.
 */
await runService("api", async ({ config, log }) => {
  if (!config.SESSION_SECRET) throw new ConfigError("api requires SESSION_SECRET (32+ random characters)");
  const db = createDb(config.DATABASE_URL, { max: 5 });
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });
  redis.on("error", (err) => log.warn({ err: err.message }, "redis error"));
  await redis.connect();

  const app = Fastify({ loggerInstance: log, disableRequestLogging: true, bodyLimit: 64 * 1024 });
  await app.register(cookie);

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

  app.get("/v1/status", async () => ({ service: "binflip-api", version: "0.1.0", mode: config.mode }));
  registerRoutes(app, db.db, config);

  await app.listen({ host: "0.0.0.0", port: config.API_PORT });
  return {
    noHealthServer: true,
    cleanups: [() => db.close(), async () => void (await redis.quit()), () => app.close()],
  };
});
