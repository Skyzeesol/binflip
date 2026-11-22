/**
 * Subset of the JSON-RPC `getTransaction` response (encoding: "json",
 * maxSupportedTransactionVersion: 0). We decode from this raw shape instead
 * of web3.js objects so fixtures are plain JSON and decoding is deterministic.
 */
export interface RawCompiledIx {
  programIdIndex: number;
  accounts: number[];
  /** base58 */
  data: string;
  stackHeight?: number | null;
}

export interface RawTokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number };
}

export interface RawTransaction {
  signature: string;
  slot: number;
  blockTime: number | null;
  transaction: {
    message: {
      accountKeys: string[];
      instructions: RawCompiledIx[];
    };
    signatures: string[];
  };
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: RawTokenBalance[];
    postTokenBalances?: RawTokenBalance[];
    innerInstructions?: Array<{ index: number; instructions: RawCompiledIx[] }>;
    loadedAddresses?: { writable: string[]; readonly: string[] };
    logMessages?: string[];
  } | null;
}

/** Static keys followed by address-lookup-table keys, in runtime order. */
export function accountKeys(tx: RawTransaction): string[] {
  const la = tx.meta?.loadedAddresses;
  return [
    ...tx.transaction.message.accountKeys,
    ...(la?.writable ?? []),
    ...(la?.readonly ?? []),
  ];
}

export interface FlatIx {
  programId: string;
  accounts: string[];
  data: string;
  /** Top-level instruction index this belongs to. */
  topIndex: number;
  /** Position inside the inner list, or null for the top-level instruction itself. */
  innerIndex: number | null;
}

/** Top-level and inner (CPI) instructions in execution order. */
export function flattenInstructions(tx: RawTransaction): FlatIx[] {
  const keys = accountKeys(tx);
  const inner = new Map<number, RawCompiledIx[]>();
  for (const g of tx.meta?.innerInstructions ?? []) inner.set(g.index, g.instructions);

  const out: FlatIx[] = [];
  tx.transaction.message.instructions.forEach((ix, topIndex) => {
    out.push(toFlat(ix, keys, topIndex, null));
    (inner.get(topIndex) ?? []).forEach((iix, innerIndex) =>
      out.push(toFlat(iix, keys, topIndex, innerIndex)),
    );
  });
  return out;
}

function toFlat(ix: RawCompiledIx, keys: string[], topIndex: number, innerIndex: number | null): FlatIx {
  return {
    programId: keys[ix.programIdIndex] ?? "",
    accounts: ix.accounts.map((i) => keys[i] ?? ""),
    data: ix.data,
    topIndex,
    innerIndex,
  };
}
