import type { RawTransaction } from "../meteora/rawTx.js";

export class RpcError extends Error {
  override name = "RpcError";
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

export interface SignatureInfo {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: unknown;
}

export interface RpcOptions {
  /** Max attempts for 429/5xx/network errors. */
  retries?: number;
  timeoutMs?: number;
}

/**
 * Minimal JSON-RPC client over fetch. We use raw JSON responses (not web3.js
 * objects) so decoding matches the test fixtures byte for byte.
 */
export class SolanaRpc {
  private id = 0;
  constructor(
    readonly url: string,
    private readonly opts: RpcOptions = {},
  ) {}

  async call<T>(method: string, params: unknown[]): Promise<T> {
    const retries = this.opts.retries ?? 5;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(this.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
        });
        if (res.status === 429 || res.status >= 500) {
          lastErr = new RpcError(`HTTP ${res.status}`, res.status);
          await backoff(attempt, res.headers.get("retry-after"));
          continue;
        }
        const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
        if (body.error) throw new RpcError(body.error.message, body.error.code);
        return body.result as T;
      } catch (err) {
        if (err instanceof RpcError && err.code !== undefined && err.code < 500 && err.code !== 429) throw err;
        lastErr = err;
        if (attempt < retries) await backoff(attempt, null);
      }
    }
    throw lastErr instanceof Error ? lastErr : new RpcError(String(lastErr));
  }

  async getTransaction(signature: string): Promise<RawTransaction | null> {
    const tx = await this.call<Omit<RawTransaction, "signature"> | null>("getTransaction", [
      signature,
      { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed" },
    ]);
    return tx ? { signature, ...tx } : null;
  }

  getSignaturesForAddress(
    address: string,
    opts: { limit?: number; until?: string; before?: string } = {},
  ): Promise<SignatureInfo[]> {
    return this.call("getSignaturesForAddress", [address, { commitment: "confirmed", ...opts }]);
  }

  async getHealth(): Promise<void> {
    await this.call("getHealth", []);
  }
}

function backoff(attempt: number, retryAfter: string | null): Promise<void> {
  const fromHeader = retryAfter ? Number(retryAfter) * 1000 : NaN;
  const ms = Number.isFinite(fromHeader) ? fromHeader : Math.min(10_000, 300 * 2 ** attempt);
  return new Promise((r) => setTimeout(r, ms + Math.random() * 200));
}

/** https://host/?api-key=… → wss://host/?api-key=… */
export function wsUrlFromHttp(url: string): string {
  return url.replace(/^http/, "ws");
}
