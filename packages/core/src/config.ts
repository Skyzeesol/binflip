import { z } from "zod";

/** "1"/"0"/"true"/"false" → boolean. Anything else is a config error. */
const flag = (def: "0" | "1") =>
  z
    .enum(["0", "1", "true", "false"])
    .default(def)
    .transform((v) => v === "1" || v === "true");

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  SERVICE_NAME: z.string().default("binflip"),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  SOLANA_RPC_URL: z.string().url().default("https://api.mainnet-beta.solana.com"),
  SOLANA_WS_URL: z.string().url().optional(),
  HELIUS_API_KEY: z.string().min(1).optional(),

  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  TELEGRAM_CHAT_ID: z.string().min(1).optional(),

  HEALTH_PORT: z.coerce.number().int().positive().default(8080),
  API_PORT: z.coerce.number().int().positive().default(3001),

  // Safety gates (HANDOFF §6). Dry-run is the default; going live needs BOTH flags.
  DRY_RUN: flag("1"),
  LIVE_CONFIRMED: flag("0"),
});

export type ExecutionMode = "dry_run" | "live";

export type Config = Omit<z.infer<typeof EnvSchema>, "DRY_RUN" | "LIVE_CONFIRMED"> & {
  mode: ExecutionMode;
};

export class ConfigError extends Error {
  override name = "ConfigError";
}

/**
 * Parse and validate the environment. Fails closed:
 * - DRY_RUN=0 without LIVE_CONFIRMED=1 is an error, not a silent fallback.
 * - LIVE_CONFIRMED=1 while DRY_RUN=1 stays dry-run.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Treat empty strings as unset so `FOO=` in .env behaves like a missing var.
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v !== ""),
  );
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new ConfigError(`Invalid configuration:\n${issues}`);
  }
  const { DRY_RUN, LIVE_CONFIRMED, ...rest } = parsed.data;

  if (!DRY_RUN && !LIVE_CONFIRMED) {
    throw new ConfigError(
      "DRY_RUN=0 requires LIVE_CONFIRMED=1. Refusing to start in an ambiguous mode.",
    );
  }
  const mode: ExecutionMode = !DRY_RUN && LIVE_CONFIRMED ? "live" : "dry_run";
  return { ...rest, mode };
}
