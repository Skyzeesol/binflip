import { readFileSync, readdirSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { decodeMeteoraTx, extractActions } from "../../../packages/core/src/index.js";
import type { SignatureJob } from "@binflip/core";

const io = vi.hoisted(() => ({
  add: vi.fn(),
  start: vi.fn(),
  signatures: vi.fn(),
  transaction: vi.fn(),
  db: { select: vi.fn(), insert: vi.fn() },
  getCursor: vi.fn(),
  setCursor: vi.fn(),
  processSignature: null as null | ((job: { data: SignatureJob }) => Promise<unknown>),
}));

vi.mock("@binflip/core", async () => ({
  ...await import("../../../packages/core/src/index.js"),
  runService: (_name: string, start: unknown) => { io.start(start); },
  SolanaRpc: class {
    getSignaturesForAddress = io.signatures;
    getTransaction = io.transaction;
  },
}));
vi.mock("@binflip/db", async () => ({
  schema: await import("../../../packages/db/src/schema.js"),
  createDb: () => ({ db: io.db, ping: async () => undefined }),
}));
vi.mock("bullmq", () => ({
  Queue: class { add = io.add; },
  Worker: class {
    constructor(_queue: string, process: typeof io.processSignature) { io.processSignature = process; }
    on() {}
  },
}));
vi.mock("ioredis", () => ({
  Redis: class {
    exists = async () => 1;
    get = io.getCursor;
    set = io.setCursor;
  },
}));
vi.mock("./logsWatcher.js", () => ({
  LogsWatcher: class { start() {} setAddresses() {} },
}));

it("recovers a leader close across paginated downtime and retries dispatch without another event row", async () => {
  const fixtures = new URL("../../../packages/core/test/fixtures/tx/", import.meta.url);
  const file = readdirSync(fixtures).find((name) => name.startsWith("dlmm-2oxGTs22bM"))!;
  const close = JSON.parse(readFileSync(new URL(file, fixtures), "utf8"));
  const [action] = extractActions(decodeMeteoraTx(close));
  const address = action!.owner!;
  const latest = Array.from({ length: 50 }, (_, i) => ({ signature: `later-${i}`, slot: 100 - i, err: null }));
  io.getCursor.mockResolvedValue("before-outage");
  io.signatures.mockResolvedValueOnce(latest).mockResolvedValueOnce([{ signature: close.signature, slot: close.slot, err: null }]);
  io.transaction.mockResolvedValue(close);
  const returning = vi.fn().mockResolvedValueOnce([{ id: "close-event" }]).mockResolvedValue([]);
  const values = vi.fn(() => ({ onConflictDoNothing: () => ({ returning }) }));
  io.db.insert.mockReturnValue({ values });
  const where = vi.fn().mockResolvedValueOnce([]).mockResolvedValue([{ id: "close-event" }]);
  io.db.select.mockReturnValueOnce({ from: async () => [{ address, userId: "user", leaderId: "leader" }] });
  io.db.select.mockReturnValue({ from: () => ({ where }) });
  const log = { info: vi.fn(), warn: vi.fn() };

  await import("./main.js");
  const start = io.start.mock.calls[0]![0];
  const hooks = await start({ config: { SOLANA_RPC_URL: "http://rpc", LISTENER_POLL_MS: 60_000 }, log });
  try {
    await vi.waitFor(() => expect(io.setCursor).toHaveBeenCalledWith(`binflip:listener:cursor:${address}`, "later-0"));
    expect(io.signatures).toHaveBeenNthCalledWith(2, address, { limit: 50, until: "before-outage", before: "later-49" });
    expect(io.add.mock.calls.filter(([name]) => name === "sig")).toHaveLength(51);
    const [closeJobName, closeJob] = io.add.mock.calls[0]!;
    expect(closeJobName).toBe("sig");
    expect(closeJob.signature).toBe(close.signature);
    expect(io.add.mock.invocationCallOrder[50]).toBeLessThan(io.setCursor.mock.invocationCallOrder[0]!);

    io.add.mockRejectedValueOnce(new Error("Redis disconnected"));
    await expect(io.processSignature!({ data: closeJob })).rejects.toThrow("Redis disconnected");
    await expect(io.processSignature!({ data: closeJob })).resolves.toEqual({ actions: 1, stored: 0 });
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ signature: close.signature, payload: expect.objectContaining({ kind: "close" }) }));
    expect(io.add.mock.calls.filter(([name]) => name === "plan").map(([, , opts]) => opts.jobId)).toEqual(["close-event", "close-event"]);
  } finally {
    hooks.cleanups.at(-1)();
  }
});
