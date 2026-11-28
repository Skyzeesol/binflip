import { PublicKey } from "@solana/web3.js";

/**
 * mm settings, validated at startup: a bad value stops the service BEFORE it can trade
 * (e.g. MM_MAX_POSITIONS=oops used to become NaN and silently disable the position limit).
 */
export interface MmConfig {
  leader: string;
  tickMs: number;
  txPollMs: number;
  statsMs: number;
  outDir: string;
  ws: boolean;
  commitment: "processed" | "confirmed";
  live: boolean;
  lotLamports: bigint;
  maxPositions: number;
  reserveLamports: bigint;
  slippageBins: number;
  priorityMicroLamports: number;
  keepDays: number;
  staleMs: number;
}

export class ConfigError extends Error {}

export function parseMmConfig(env: NodeJS.ProcessEnv): MmConfig {
  const errors: string[] = [];
  const int = (name: string, def: number, min: number, max: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === "") return def;
    const v = Number(raw);
    if (!Number.isInteger(v) || v < min || v > max) {
      errors.push(`${name}=${JSON.stringify(raw)}: expected an integer in [${min}, ${max}]`);
      return def;
    }
    return v;
  };
  const sol = (name: string, def: number, min: number, max: number): bigint => {
    const raw = env[name];
    if (raw === undefined || raw === "") return BigInt(Math.round(def * 1e9));
    const v = Number(raw);
    if (!Number.isFinite(v) || v < min || v > max) {
      errors.push(`${name}=${JSON.stringify(raw)}: expected SOL in [${min}, ${max}]`);
      return BigInt(Math.round(def * 1e9));
    }
    return BigInt(Math.round(v * 1e9));
  };
  const oneOf = <T extends string>(name: string, def: T, allowed: readonly T[]): T => {
    const raw = env[name];
    if (raw === undefined || raw === "") return def;
    if (!allowed.includes(raw as T)) {
      errors.push(`${name}=${JSON.stringify(raw)}: expected one of ${allowed.join(", ")}`);
      return def;
    }
    return raw as T;
  };

  const leader = env.MM_LEADER ?? "BviQcBvnWv5HHxHcouTwRFhrAMPNKuMLzEaSuxCuv6eU";
  try {
    new PublicKey(leader);
  } catch {
    errors.push(`MM_LEADER=${JSON.stringify(leader)}: not a public key`);
  }
  const cfg: MmConfig = {
    leader,
    tickMs: int("MM_TICK_MS", 2000, 250, 60_000),
    txPollMs: int("MM_TX_POLL_MS", 3000, 500, 60_000),
    statsMs: int("MM_STATS_MS", 60_000, 1000, 3_600_000),
    outDir: env.MM_OUT_DIR || "mm-data",
    ws: oneOf("MM_WS", "1", ["0", "1"] as const) === "1",
    commitment: oneOf("MM_COMMITMENT", "processed", ["processed", "confirmed"] as const),
    live: oneOf("MM_LIVE", "0", ["0", "1"] as const) === "1",
    lotLamports: sol("MM_LOT_SOL", 0.1, 0.01, 5),
    maxPositions: int("MM_MAX_POSITIONS", 3, 1, 20),
    reserveLamports: sol("MM_RESERVE_SOL", 0.15, 0.05, 100),
    slippageBins: int("MM_SLIPPAGE_BINS", 0, 0, 10),
    priorityMicroLamports: int("MM_PRIORITY_MICROLAMPORTS", 10_000, 0, 10_000_000),
    keepDays: int("MM_KEEP_DAYS", 14, 1, 365),
    staleMs: int("MM_STALE_MS", 30_000, 5_000, 600_000),
  };
  if (errors.length) throw new ConfigError(`invalid mm settings (nothing started):\n  ${errors.join("\n  ")}`);
  return cfg;
}
