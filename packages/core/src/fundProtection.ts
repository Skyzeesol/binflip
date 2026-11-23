/**
 * LP Agent fund protection: "pauses new copies when your losses from copied
 * positions reach a limit. Losses count closed copy positions only, measured
 * from their peak since the limit was set. On save, the percentage becomes a
 * fixed SOL amount from your net worth that day, and the count restarts."
 */
export interface FundProtectionInput {
  /** Cumulative realized PnL (lamports) of copies closed since the count started. */
  realizedLamports: bigint;
  /** Highest cumulative realized PnL seen since the count started. */
  peakLamports: bigint;
  /** Fixed SOL limit; null until it has been computed from net worth. */
  limitLamports: bigint | null;
  lossBps: number;
  netWorthLamports: bigint;
}

export interface FundProtectionState {
  peakLamports: bigint;
  limitLamports: bigint;
  drawdownLamports: bigint;
  tripped: boolean;
}

export function evaluateFundProtection(i: FundProtectionInput): FundProtectionState {
  const limitLamports = i.limitLamports ?? (i.netWorthLamports * BigInt(i.lossBps)) / 10_000n;
  const peakLamports = i.realizedLamports > i.peakLamports ? i.realizedLamports : i.peakLamports;
  const drawdownLamports = peakLamports - i.realizedLamports;
  return { peakLamports, limitLamports, drawdownLamports, tripped: limitLamports > 0n && drawdownLamports >= limitLamports };
}
