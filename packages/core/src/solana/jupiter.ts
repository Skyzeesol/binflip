import { VersionedTransaction } from "@solana/web3.js";
import { WSOL_MINT } from "../constants.js";

export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  priceImpactPct: string;
  routePlan: Array<{ swapInfo: { label: string } }>;
  [k: string]: unknown;
}

export class NoRouteError extends Error {
  override name = "NoRouteError";
}

/**
 * Jupiter Swap API v1 (lite-api, no key). Used only to sell a token back to SOL
 * on exits (HANDOFF §5). No platform fee is requested, so Jupiter takes none.
 */
export class JupiterClient {
  constructor(readonly baseUrl = "https://lite-api.jup.ag/swap/v1") {}

  async quoteToSol(mint: string, amount: bigint, slippageBps: number): Promise<JupiterQuote> {
    const url = `${this.baseUrl}/quote?inputMint=${mint}&outputMint=${WSOL_MINT}&amount=${amount}&slippageBps=${slippageBps}&restrictIntermediateTokens=true`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    const body = (await res.json()) as JupiterQuote & { error?: string; errorCode?: string };
    if (!res.ok || body.error || !body.outAmount) {
      const msg = body.error ?? `HTTP ${res.status}`;
      if (res.status === 400 || /route|no.*market|not tradable/i.test(msg)) throw new NoRouteError(msg);
      throw new Error(`jupiter quote: ${msg}`);
    }
    return body;
  }

  async buildSwap(
    quote: JupiterQuote,
    user: string,
    maxPriorityLamports: number,
  ): Promise<{ tx: VersionedTransaction; lastValidBlockHeight: number }> {
    const res = await fetch(`${this.baseUrl}/swap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: user,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: maxPriorityLamports, priorityLevel: "high" } },
      }),
    });
    const body = (await res.json()) as { swapTransaction?: string; lastValidBlockHeight?: number; error?: string };
    if (!res.ok || !body.swapTransaction) throw new Error(`jupiter swap: ${body.error ?? `HTTP ${res.status}`}`);
    return {
      tx: VersionedTransaction.deserialize(Buffer.from(body.swapTransaction, "base64")),
      lastValidBlockHeight: body.lastValidBlockHeight ?? 0,
    };
  }
}
