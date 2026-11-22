import { createRequire } from "node:module";
import { BorshCoder, type Idl } from "@coral-xyz/anchor";
import bs58 from "bs58";
import { PROGRAM_IDS } from "../constants.js";
import { flattenInstructions, type FlatIx, type RawTransaction } from "./rawTx.js";

// @meteora-ag/dlmm's ESM build uses a directory import Node rejects, so load
// both SDKs through their CommonJS builds.
const require = createRequire(import.meta.url);
const DLMM_IDL = (require("@meteora-ag/dlmm") as typeof import("@meteora-ag/dlmm")).IDL;
const CpAmmIdl = (require("@meteora-ag/cp-amm-sdk") as typeof import("@meteora-ag/cp-amm-sdk")).CpAmmIdl;

export type Protocol = "dlmm" | "damm_v2";

/** Anchor's emit_cpi! prefix: sha256("anchor:event")[..8]. */
const EVENT_IX_TAG = Buffer.from("e445a52e51cb9a1d", "hex"); // LE u64 0x1d9acb512ea545e4

const coders: Record<Protocol, BorshCoder> = {
  dlmm: new BorshCoder(DLMM_IDL as unknown as Idl),
  damm_v2: new BorshCoder(CpAmmIdl as unknown as Idl),
};

const PROTOCOL_BY_PROGRAM: Record<string, Protocol> = {
  [PROGRAM_IDS.DLMM]: "dlmm",
  [PROGRAM_IDS.DAMM_V2]: "damm_v2",
};

const ixAccountNames: Record<Protocol, Map<string, string[]>> = {
  dlmm: new Map(DLMM_IDL.instructions.map((i) => [i.name, i.accounts.map((a) => a.name)])),
  damm_v2: new Map(CpAmmIdl.instructions.map((i) => [i.name, i.accounts.map((a) => a.name)])),
};

export interface DecodedIx {
  kind: "ix";
  protocol: Protocol;
  name: string;
  /** Named accounts per the IDL. */
  accounts: Record<string, string>;
  args: Record<string, unknown>;
  topIndex: number;
  innerIndex: number | null;
}

export interface DecodedEvent {
  kind: "event";
  protocol: Protocol;
  name: string;
  data: Record<string, unknown>;
  topIndex: number;
}

export type Decoded = DecodedIx | DecodedEvent;

/**
 * Decode every Meteora DLMM / DAMM V2 instruction and emitted event in a
 * transaction, including ones reached through CPI (routers, other bots).
 * Unknown data is skipped, never thrown.
 */
export function decodeMeteoraTx(tx: RawTransaction): Decoded[] {
  const out: Decoded[] = [];
  for (const ix of flattenInstructions(tx)) {
    const protocol = PROTOCOL_BY_PROGRAM[ix.programId];
    if (!protocol) continue;
    const decoded = decodeOne(protocol, ix);
    if (decoded) out.push(decoded);
  }
  return out;
}

function decodeOne(protocol: Protocol, ix: FlatIx): Decoded | null {
  let data: Buffer;
  try {
    data = Buffer.from(bs58.decode(ix.data));
  } catch {
    return null;
  }
  const coder = coders[protocol];

  if (data.length >= 16 && data.subarray(0, 8).equals(EVENT_IX_TAG)) {
    try {
      const ev = coder.events.decode(data.subarray(8).toString("base64"));
      if (!ev) return null;
      return { kind: "event", protocol, name: ev.name, data: normalize(ev.data), topIndex: ix.topIndex };
    } catch {
      return null;
    }
  }

  try {
    const dec = coder.instruction.decode(data);
    if (!dec) return null;
    const names = ixAccountNames[protocol].get(dec.name) ?? [];
    const accounts: Record<string, string> = {};
    names.forEach((n, i) => {
      const a = ix.accounts[i];
      if (a) accounts[n] = a;
    });
    return {
      kind: "ix",
      protocol,
      name: dec.name,
      accounts,
      args: normalize(dec.data) as Record<string, unknown>,
      topIndex: ix.topIndex,
      innerIndex: ix.innerIndex,
    };
  } catch {
    return null;
  }
}

/** BN → bigint, PublicKey → base58, recursively. */
function normalize(v: unknown): any {
  if (v === null || v === undefined) return v;
  if (typeof v !== "object") return v;
  const ctor = (v as { constructor?: { name?: string } }).constructor?.name;
  if (ctor === "BN") return BigInt((v as { toString(base?: number): string }).toString(10));
  if (ctor === "PublicKey") return (v as { toBase58(): string }).toBase58();
  if (Array.isArray(v)) return v.map(normalize);
  if (v instanceof Uint8Array) return Array.from(v);
  const o: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) o[k] = normalize(val);
  return o;
}
