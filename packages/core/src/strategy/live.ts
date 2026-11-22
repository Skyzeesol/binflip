import type { DlmmTxBuilder } from "../meteora/dlmmTx.js";
import type { ManagedPosition } from "./manage.js";

/** The subset of a positions row needed to model a live position. */
export interface LivePositionRow {
  pool: string;
  ourPosition: string | null;
  depositedSol: bigint;
  peakValue: string | null;
  entryActiveBinId: number | null;
  lastFlipBinId: number | null;
}

/**
 * Read a live position from chain into the engine's model. Unclaimed fees
 * count as value (they are ours); claimed fees are already back in the wallet.
 * SOL-as-Y pools only (checked by the caller via poolInfo.solIsY).
 */
export async function readLivePosition(
  builder: DlmmTxBuilder,
  row: LivePositionRow,
): Promise<{ state: ManagedPosition; activeId: number; binStep: number; feeX: bigint; feeY: bigint }> {
  if (!row.ourPosition) throw new Error("position has no on-chain address");
  const info = await builder.poolInfo(row.pool);
  const pb = await builder.positionBins(row.pool, row.ourPosition);
  const deposited = Number(row.depositedSol);
  const peak = row.peakValue ? Number(row.peakValue) * 1e9 : deposited;
  const unclaimedY = Number(pb.feeY) + Number(pb.feeX) * Math.pow(1 + info.binStep / 10_000, info.activeBinId);
  return {
    activeId: info.activeBinId,
    binStep: info.binStep,
    feeX: pb.feeX,
    feeY: pb.feeY,
    state: {
      bins: pb.bins,
      activeId: info.activeBinId,
      binStep: info.binStep,
      depositedY: deposited,
      claimedFeesY: unclaimedY,
      peakY: peak,
      entryActiveId: row.entryActiveBinId ?? info.activeBinId,
      lastFlipActiveId: row.lastFlipBinId,
      lowerBinId: pb.lower,
      upperBinId: pb.upper,
    },
  };
}
