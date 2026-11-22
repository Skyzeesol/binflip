import { loadConfig, type Config } from "./config.js";
import { startHealthServer, type HealthCheck } from "./health.js";
import { onShutdown } from "./lifecycle.js";
import { createLogger, type Logger } from "./logger.js";

export interface ServiceContext {
  config: Config;
  log: Logger;
}

export interface ServiceHooks {
  /** Health checks exposed on GET /health. */
  checks?: Record<string, HealthCheck>;
  /** Cleanups run on shutdown (reverse order). */
  cleanups?: Array<() => Promise<void> | void>;
  /** Skip the built-in health server (e.g. the API serves its own /health). */
  noHealthServer?: boolean;
}

/**
 * Common bootstrap for every service: validated config, structured logger,
 * health endpoint and graceful shutdown. Config errors exit with code 78 so
 * Docker restarts make the misconfiguration obvious in logs.
 */
export async function runService(
  name: string,
  start: (ctx: ServiceContext) => Promise<ServiceHooks>,
): Promise<void> {
  const bootLog = createLogger(name, process.env.LOG_LEVEL ?? "info");
  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    bootLog.fatal({ err }, "invalid configuration");
    process.exit(78);
  }
  const log = createLogger(name, config.LOG_LEVEL);
  log.info({ mode: config.mode, node: process.version }, "starting");
  if (config.mode === "live") log.warn("LIVE MODE: real transactions will be signed");

  try {
    const hooks = await start({ config, log });
    const cleanups = [...(hooks.cleanups ?? [])];
    if (!hooks.noHealthServer) {
      const server = startHealthServer(config.HEALTH_PORT, hooks.checks ?? {}, {
        service: name,
        mode: config.mode,
      });
      cleanups.unshift(() => new Promise<void>((r) => server.close(() => r())));
    }
    onShutdown(log, cleanups);
    log.info("ready");
  } catch (err) {
    log.fatal({ err }, "failed to start");
    process.exit(1);
  }
}
