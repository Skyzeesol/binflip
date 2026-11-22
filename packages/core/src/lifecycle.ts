import type { Logger } from "pino";

type Cleanup = () => Promise<void> | void;

/**
 * Register graceful shutdown on SIGINT/SIGTERM. Cleanups run in reverse
 * registration order; the process exits non-zero if shutdown hangs.
 */
export function onShutdown(log: Logger, cleanups: Cleanup[], timeoutMs = 10_000): void {
  let shuttingDown = false;
  const handler = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, "shutting down");
    const timer = setTimeout(() => {
      log.error("shutdown timed out, forcing exit");
      process.exit(1);
    }, timeoutMs);
    timer.unref();
    for (const fn of [...cleanups].reverse()) {
      try {
        await fn();
      } catch (err) {
        log.error({ err }, "cleanup failed");
      }
    }
    log.info("bye");
    process.exit(0);
  };
  process.on("SIGINT", () => void handler("SIGINT"));
  process.on("SIGTERM", () => void handler("SIGTERM"));
  process.on("unhandledRejection", (err) => log.error({ err }, "unhandled rejection"));
}
