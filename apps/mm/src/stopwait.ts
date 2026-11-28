import fs from "node:fs";
import path from "node:path";
import { closeAllMtime, runningRunId, stopSafe, type LiveStatus } from "./status.js";

/**
 * Wait until it is safe to stop after CLOSE_ALL (run inside the service container):
 *   docker compose -f docker-compose.mm.yml exec mm node apps/mm/dist/stopwait.js [maxMinutes=30]
 * Exit 0 = safe to `down`; exit 1 = not safe within the time (do not stop).
 */
const dir = process.env.MM_OUT_DIR ?? "mm-data";
const closeAllFile = process.env.MM_CLOSE_ALL_FILE ?? path.join(dir, "CLOSE_ALL");
const deadline = Date.now() + Number(process.argv[2] ?? 30) * 60_000;
let last = "";
for (;;) {
  let st: LiveStatus | null = null;
  try {
    st = JSON.parse(fs.readFileSync(path.join(dir, "live-status.json"), "utf8")) as LiveStatus;
  } catch {
    st = null;
  }
  const r = stopSafe(st, closeAllMtime(closeAllFile), runningRunId(path.join(dir, "mm.lock")));
  if (r.why !== last) console.log(new Date().toISOString(), r.why);
  last = r.why;
  if (r.ok) process.exit(0);
  if (Date.now() > deadline) process.exit(1);
  await new Promise((res) => setTimeout(res, 5000));
}
