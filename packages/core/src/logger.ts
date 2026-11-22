import { pino, type Logger } from "pino";

/** Paths that must never reach logs, even by accident. */
const REDACT = [
  "secretKey",
  "privateKey",
  "keypair",
  "seed",
  "mnemonic",
  "passphrase",
  "password",
  "token",
  "*.secretKey",
  "*.privateKey",
  "*.keypair",
  "*.seed",
  "*.mnemonic",
  "*.passphrase",
  "*.password",
  "*.token",
  "config.TELEGRAM_BOT_TOKEN",
  "config.HELIUS_API_KEY",
  "config.DATABASE_URL",
];

export function createLogger(service: string, level = "info"): Logger {
  return pino({
    level,
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT, censor: "[REDACTED]" },
  });
}

export type { Logger };
