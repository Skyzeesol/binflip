import { HttpsProxyAgent } from "https-proxy-agent";
import WebSocket from "ws";
import type { Logger } from "@binflip/core";

export interface LogNotification {
  address: string;
  signature: string;
  slot: number;
  err: unknown;
  logs: string[];
}

/**
 * One WebSocket connection with a logsSubscribe(mentions: [address]) per
 * leader. Reconnects with backoff and resubscribes everything. Missed
 * notifications during a disconnect are recovered by the poller.
 */
export class LogsWatcher {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly wanted = new Set<string>();
  private readonly pending = new Map<number, string>(); // request id → address
  private readonly subs = new Map<number, string>(); // subscription id → address
  private readonly bySubAddress = new Map<string, number>();
  private attempts = 0;
  private closed = false;
  private pingTimer: NodeJS.Timeout | null = null;
  connected = false;

  constructor(
    private readonly url: string,
    private readonly log: Logger,
    private readonly onLogs: (n: LogNotification) => void,
    private readonly onReconnect: () => void,
  ) {}

  start() {
    this.connect();
  }

  setAddresses(addresses: string[]) {
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

  async close() {
    this.closed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.ws?.close();
  }

  private connect() {
    const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
    const ws = new WebSocket(this.url, proxy ? { agent: new HttpsProxyAgent(proxy) } : {});
    this.ws = ws;

    ws.on("open", () => {
      this.connected = true;
      const wasReconnect = this.attempts > 0;
      this.attempts = 0;
      this.log.info({ leaders: this.wanted.size }, "websocket connected");
      this.subs.clear();
      this.bySubAddress.clear();
      for (const a of this.wanted) this.subscribe(a);
      this.pingTimer = setInterval(() => ws.readyState === ws.OPEN && ws.ping(), 20_000);
      if (wasReconnect) this.onReconnect();
    });

    ws.on("message", (raw) => this.handle(raw.toString()));

    ws.on("close", (code) => {
      this.connected = false;
      if (this.pingTimer) clearInterval(this.pingTimer);
      if (this.closed) return;
      const delay = Math.min(30_000, 500 * 2 ** this.attempts++);
      this.log.warn({ code, delay }, "websocket closed, reconnecting");
      setTimeout(() => this.connect(), delay);
    });

    ws.on("error", (err) => this.log.warn({ err: err.message }, "websocket error"));
  }

  private send(method: string, params: unknown[]): number | null {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return null;
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return id;
  }

  private subscribe(address: string) {
    const id = this.send("logsSubscribe", [{ mentions: [address] }, { commitment: "confirmed" }]);
    if (id !== null) this.pending.set(id, address);
  }

  private unsubscribe(address: string) {
    const sub = this.bySubAddress.get(address);
    if (sub === undefined) return;
    this.send("logsUnsubscribe", [sub]);
    this.subs.delete(sub);
    this.bySubAddress.delete(address);
  }

  private handle(text: string) {
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
        this.subs.set(msg.result, address);
        this.bySubAddress.set(address, msg.result);
        this.log.debug({ address, sub: msg.result }, "subscribed");
      } else {
        this.log.error({ address, error: msg.error }, "subscribe failed");
      }
      return;
    }
    if (msg.method === "logsNotification") {
      const sub = msg.params?.subscription;
      const address = this.subs.get(sub);
      const v = msg.params?.result?.value;
      if (!address || !v?.signature) return;
      this.onLogs({
        address,
        signature: v.signature,
        slot: msg.params.result.context?.slot ?? 0,
        err: v.err,
        logs: v.logs ?? [],
      });
    }
  }
}
