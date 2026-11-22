import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { createLogger } from "@binflip/core";

const log = createLogger("migrate", process.env.LOG_LEVEL ?? "info");
const url = process.env.DATABASE_URL;
if (!url) {
  log.fatal("DATABASE_URL is not set");
  process.exit(1);
}

// dist/migrate.js → ../drizzle
const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  await migrate(drizzle(sql), { migrationsFolder });
  log.info({ migrationsFolder }, "migrations applied");
} catch (err) {
  log.fatal({ err }, "migration failed");
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
