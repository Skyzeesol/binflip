import { HttpsProxyAgent } from "https-proxy-agent";
import WebSocket from "ws";
import type { Logger } from "@binflip/core";

/**
 * accountSubscribe on a set of accounts (the pools' LbPair), one WebSocket.
 * Every change to a pool (each swap that moves the active bin) arrives as a push,
 * typically within a slot, instead of waiting for the next poll. Reconnects with
 * backoff and resubscribes; the caller keeps a slow poll as a fallback.
 */
export class AccountWatcher {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly wanted = new Set<string>();
  private readonly pending = new Map<number, string>(); // request id → address
  private readonly subs = new Map<number, string>(); // subscription id → address
  private readonly byAddress = new Map<string, number>();
  private attempts = 0;
  private closed = false;
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly retryTimers = new Set<NodeJS.Timeout>();
  connected = false;
  notifications = 0;

  constructor(
    private readonly url: string,
    private readonly log: Logger,
    private readonly onAccount: (address: string, dataBase64: string, slot: number) => void,
    private readonly commitment: "processed" | "confirmed" = "processed",
    /** Injectable for tests; the default opens a real WebSocket (through HTTPS_PROXY if set). */
    private readonly open: (url: string) => WebSocket = (url) => {
      const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
      return new WebSocket(url, proxy ? { agent: new HttpsProxyAgent(proxy) } : {});
    },
    private readonly retryMs = 5_000,
  ) {}

  start(): void {
    this.connect();
  }

  setAddresses(addresses: string[]): void {
    const next = new Set(addresses);
    for (const a of next) if (!this.wanted.has(a)) {
      this.wanted.add(a);
      this.subscribe(a);
    }
    for (const a of [...this.wanted]) if (!next.has(a)) {
      this.wanted.delete(a);
      this.unsubscribe(a);
    }
  }

  close(): void {
    this.closed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer); // a scheduled reconnect must not run after close()
    for (const t of this.retryTimers) clearTimeout(t);
    this.retryTimers.clear();
    this.ws?.close();
  }

  private connect(): void {
    if (this.closed) return;
    const ws = this.open(this.url);
    this.ws = ws;
    ws.on("open", () => {
      this.connected = true;
      this.attempts = 0;
      this.subs.clear();
      this.byAddress.clear();
      this.pending.clear();
      for (const a of this.wanted) this.subscribe(a);
      this.pingTimer = setInterval(() => ws.readyState === ws.OPEN && ws.ping(), 20_000);
      this.log.info({ accounts: this.wanted.size }, "account websocket connected");
    });
    ws.on("message", (raw) => this.handle(raw.toString()));
    ws.on("close", (code) => {
      this.connected = false;
      if (this.pingTimer) clearInterval(this.pingTimer);
      if (this.closed) return;
      const delay = Math.min(30_000, 500 * 2 ** this.attempts++);
      this.log.warn({ code, delay }, "account websocket closed, reconnecting");
      this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, delay);
    });
    ws.on("error", (err) => this.log.warn({ err: err.message }, "account websocket error"));
  }

  private send(method: string, params: unknown[]): number | null {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return null;
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return id;
  }

  private subscribe(address: string): void {
    const id = this.send("accountSubscribe", [address, { encoding: "base64", commitment: this.commitment }]);
    if (id !== null) this.pending.set(id, address);
  }

  private unsubscribe(address: string): void {
    const sub = this.byAddress.get(address);
    if (sub === undefined) return;
    this.send("accountUnsubscribe", [sub]);
    this.subs.delete(sub);
    this.byAddress.delete(address);
  }

  private handle(text: string): void {
    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const address = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (typeof msg.result === "number") {
        if (!this.wanted.has(address)) {
          // removed while the subscribe was in flight: drop the subscription the server just made
          this.send("accountUnsubscribe", [msg.result]);
          return;
        }
        this.subs.set(msg.result, address);
        this.byAddress.set(address, msg.result);
      } else {
        this.log.warn({ address, error: msg.error }, "accountSubscribe failed, retrying");
        const t = setTimeout(() => {
          this.retryTimers.delete(t);
          if (!this.closed && this.wanted.has(address) && !this.byAddress.has(address)) this.subscribe(address);
        }, this.retryMs);
        this.retryTimers.add(t);
      }
      return;
    }
    if (msg.method === "accountNotification") {
      const address = this.subs.get(msg.params?.subscription);
      const data = msg.params?.result?.value?.data;
      if (!address || !Array.isArray(data)) return;
      this.notifications++;
      this.onAccount(address, data[0], msg.params.result.context?.slot ?? 0);
    }
  }
}
