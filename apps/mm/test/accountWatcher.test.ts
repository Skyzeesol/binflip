// WebSocket subscription bookkeeping on a fake socket (no network).
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountWatcher } from "../src/accountWatcher.js";

class FakeWs extends EventEmitter {
  static OPEN = 1;
  OPEN = 1;
  readyState = 0;
  sent: Array<{ id: number; method: string; params: unknown[] }> = [];
  send(t: string) { this.sent.push(JSON.parse(t)); }
  ping() {}
  close() { this.readyState = 3; this.emit("close", 1000); }
  up() { this.readyState = 1; this.emit("open"); }
  reply(id: number, body: object) { this.emit("message", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, ...body }))); }
}
const log = { info() {}, warn() {}, error() {}, debug() {} } as never;

afterEach(() => vi.useRealTimers());

describe("AccountWatcher", () => {
  it("a pool removed before its subscribe reply is unsubscribed when the reply comes", () => {
    const sockets: FakeWs[] = [];
    const w = new AccountWatcher("wss://x", log, () => {}, "processed", () => { const s = new FakeWs(); sockets.push(s); return s as never; });
    w.start();
    sockets[0]!.up();
    w.setAddresses(["A"]);
    const sub = sockets[0]!.sent.find((m) => m.method === "accountSubscribe")!;
    w.setAddresses([]); // removed while pending
    sockets[0]!.reply(sub.id, { result: 77 });
    expect(sockets[0]!.sent.filter((m) => m.method === "accountUnsubscribe").map((m) => m.params)).toEqual([[77]]);
  });

  it("a failed subscribe is retried", () => {
    vi.useFakeTimers();
    const sockets: FakeWs[] = [];
    const w = new AccountWatcher("wss://x", log, () => {}, "processed", () => { const s = new FakeWs(); sockets.push(s); return s as never; }, 1000);
    w.start();
    sockets[0]!.up();
    w.setAddresses(["A"]);
    const first = sockets[0]!.sent.filter((m) => m.method === "accountSubscribe");
    sockets[0]!.reply(first[0]!.id, { error: { code: -32000, message: "rate limited" } });
    vi.advanceTimersByTime(1000);
    expect(sockets[0]!.sent.filter((m) => m.method === "accountSubscribe")).toHaveLength(2);
    w.close();
  });

  it("close() cancels a reconnect that was already scheduled", () => {
    vi.useFakeTimers();
    const sockets: FakeWs[] = [];
    const w = new AccountWatcher("wss://x", log, () => {}, "processed", () => { const s = new FakeWs(); sockets.push(s); return s as never; });
    w.start();
    sockets[0]!.up();
    sockets[0]!.emit("close", 1006); // drop: a reconnect is scheduled
    w.close();
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
  });
});
