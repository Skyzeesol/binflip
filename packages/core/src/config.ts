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
  /** Signs panel session cookies (api only). 32+ random characters; not a wallet key. */
  SESSION_SECRET: z.string().min(32).optional(),
  /** Comma-separated origins the panel is opened from; the sign-in message is bound to one of them. */
  PANEL_ORIGINS: z.string().default("http://localhost:3000,http://127.0.0.1:3000"),
  /** Backup polling interval for leader signatures (gap recovery when WS is late or drops). */
  LISTENER_POLL_MS: z.coerce.number().int().min(1000).default(5000),

  /** Encrypted agent-wallet keystore (JSON) and the file holding its passphrase (Docker secret). */
  KEYSTORE_PATH: z.string().min(1).optional(),
  KEYSTORE_PASSPHRASE_FILE: z.string().min(1).optional(),
  /** Priority fee in micro-lamports per compute unit. */
  PRIORITY_FEE_MICROLAMPORTS: z.coerce.number().int().min(0).default(50_000),
  /** SOL kept free for rent and fees on top of each copy (lamports). */
  SOL_RESERVE_LAMPORTS: z.coerce.number().int().min(0).default(100_000_000),
  /**
   * Profit sweep: after a close, anything above SWEEP_KEEP_LAMPORTS + SWEEP_MIN_LAMPORTS
   * goes to SWEEP_TO_ADDRESS (your main wallet's PUBLIC address). Set only here, on the server.
   */
  /** Auto-compound only when unclaimed fees are worth at least this (lamports). */
  COMPOUND_MIN_LAMPORTS: z.coerce.number().int().min(0).default(20_000_000),
  SWEEP_TO_ADDRESS: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "base58 address").optional(),
  SWEEP_KEEP_LAMPORTS: z.coerce.number().int().min(0).default(5_000_000_000),
  SWEEP_MIN_LAMPORTS: z.coerce.number().int().min(0).default(500_000_000),

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
export function loadConfig(env: NodeJS.ProcessEnv = process.env, { requiresSigner = true } = {}): Config {
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
  if (requiresSigner && mode === "live" && (!rest.KEYSTORE_PATH || !rest.KEYSTORE_PASSPHRASE_FILE)) {
    throw new ConfigError("Live mode requires KEYSTORE_PATH and KEYSTORE_PASSPHRASE_FILE.");
  }
  return { ...rest, mode };
}
