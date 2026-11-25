// Minimal JSON-RPC client. Rate limits (429/5xx/timeouts) are retried forever with backoff;
// only genuine RPC errors throw.
export const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let id = 0;
export async function rpc(method, params) {
  let wait = 1000;
  for (;;) {
    try {
      const res = await fetch(RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }), signal: AbortSignal.timeout(30000) });
      if (res.status === 429 || res.status >= 500) throw new Error(`http ${res.status}`);
      const j = await res.json();
      if (j.error) {
        if (j.error.code === 429 || /rate|limit|timeout|busy/i.test(j.error.message)) throw new Error(j.error.message);
        const e = new Error(`${method}: ${j.error.message}`); e.fatal = true; throw e;
      }
      return j.result;
    } catch (e) {
      if (e.fatal) throw e;
      await sleep(wait + Math.random() * 500); wait = Math.min(wait * 2, 60000);
    }
  }
}
