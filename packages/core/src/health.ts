import { createServer, type Server } from "node:http";

export type HealthCheck = () => Promise<void>;

/**
 * Minimal HTTP health endpoint for worker services.
 * GET /health → 200 when every check passes, 503 otherwise.
 */
export function startHealthServer(
  port: number,
  checks: Record<string, HealthCheck>,
  meta: Record<string, unknown> = {},
): Server {
  const server = createServer(async (req, res) => {
    if (req.url !== "/health") {
      res.writeHead(404).end();
      return;
    }
    const results: Record<string, string> = {};
    let ok = true;
    await Promise.all(
      Object.entries(checks).map(async ([name, check]) => {
        try {
          await withTimeout(check(), 2000);
          results[name] = "ok";
        } catch (err) {
          ok = false;
          results[name] = err instanceof Error ? err.message : "error";
        }
      }),
    );
    res.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: ok ? "ok" : "degraded", checks: results, ...meta }));
  });
  server.listen(port);
  return server;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
