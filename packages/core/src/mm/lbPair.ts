import { createRequire } from "node:module";
import { BorshCoder, type Idl } from "@coral-xyz/anchor";

// Same CJS route as meteora/decode.ts: the SDK's ESM build is broken under Node.
const require = createRequire(import.meta.url);
const DLMM_IDL = (require("@meteora-ag/dlmm") as typeof import("@meteora-ag/dlmm")).IDL;
const coder = new BorshCoder(DLMM_IDL as unknown as Idl);

export interface LbPairState {
  activeId: number;
  binStep: number;
  volatilityAccumulator: number;
}

/** Decode the fields the engine needs from a raw LbPair account. */
export function decodeLbPair(data: Buffer): LbPairState {
  const d = coder.accounts.decode("LbPair", data) as {
    active_id: number;
    bin_step: number;
    v_parameters: { volatility_accumulator: number };
  };
  return { activeId: d.active_id, binStep: d.bin_step, volatilityAccumulator: d.v_parameters.volatility_accumulator };
}
