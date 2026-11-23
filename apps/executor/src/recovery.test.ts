import { expect, it, vi } from "vitest";
import { agentWallets, leaderEvents, positions, txs } from "../../../packages/db/src/schema.js";
import type { ExecutionJob } from "@binflip/core";
import { WSOL_MINT } from "../../../packages/core/src/constants.js";

const io = vi.hoisted(() => ({
  start: vi.fn(),
  db: { select: vi.fn(), update: vi.fn(), transaction: vi.fn() },
  enqueueSwap: vi.fn(),
  send: vi.fn(),
  signatureStatus: vi.fn(),
  process: null as null | ((job: { data: ExecutionJob }) => Promise<unknown>),
}));
vi.mock("@binflip/core", async () => ({
  ...await import("../../../packages/core/src/index.js"),
  runService: (_name: string, start: unknown) => { io.start(start); },
  KeystoreSigner: { fromFile: () => ({ publicKey: "11111111111111111111111111111111" }) },
  readPassphraseFile: () => "test-only",
  createConnection: () => ({ getBalance: async () => 0 }),
  DlmmTxBuilder: class {},
  DammTxBuilder: class {},
  TxSender: class { send = io.send; status = io.signatureStatus; },
}));
vi.mock("@binflip/db", async () => ({
  schema: await import("../../../packages/db/src/schema.js"),
  createDb: () => ({ db: io.db, ping: async () => undefined }),
}));
vi.mock("bullmq", () => ({
  Queue: class { add = async () => undefined; },
  Worker: class {
    constructor(_queue: string, process: typeof io.process) { io.process = process; }
    on() {}
  },
}));
vi.mock("ioredis", () => ({ Redis: class {} }));
vi.mock("./management.js", () => ({ startManagement: () => ({}) }));
vi.mock("./swapback.js", () => ({ startSwapBack: () => ({ enqueue: io.enqueueSwap }) }));

it("repairs a chain-confirmed close after restart and retries the follow-up without closing or sending twice", async () => {
  const event = {
    id: "event", userId: "user", processedAt: null as Date | null, leaderPosition: "leader-position",
    payload: { kind: "close", protocol: "dlmm", pool: "pool", mintX: "token", mintY: WSOL_MINT },
  };
  const transaction = {
    id: "transaction", kind: "close", status: "submitted", dryRun: false,
    plan: { plan: { do: "close" }, signatures: ["chain-signature"], completion: { ourPosition: null, received: "50", fees: 5000 } },
  };
  const position = { id: "position", state: "ACTIVE" };
  const joined = { leader_events: event, leaders: { label: "leader" }, copy_settings: { smartTokenRetention: false } };
  io.db.select.mockReturnValue({
    from: (table: unknown) => {
      if (table === leaderEvents) return { innerJoin: () => ({ innerJoin: () => ({ where: async () => [joined] }) }) };
      return { where: async () => table === agentWallets ? [{ id: "wallet" }] : table === positions ? [position] : [transaction] };
    },
  });
  const applyPosition = vi.fn((patch) => Object.assign(position, patch));
  const txUpdate = vi.fn((table) => ({
    set: (patch: object) => ({ where: async () => table === positions ? applyPosition(patch) : Object.assign(transaction, patch) }),
  }));
  io.db.transaction.mockImplementation((fn) => fn({ update: txUpdate }));
  io.db.update.mockImplementation(() => ({
    set: (patch: object) => ({ where: async () => Object.assign(event, patch) }),
  }));
  io.enqueueSwap.mockRejectedValueOnce(new Error("Redis disconnected")).mockResolvedValue(undefined);

  await import("./main.js");
  const start = io.start.mock.calls[0]![0];
  const context = { config: { mode: "live" }, log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } };
  const job = { data: { leaderEventId: event.id } };

  await start(context);
  await expect(io.process!(job)).rejects.toThrow("Redis disconnected");
  expect(transaction.status).toBe("confirmed");
  expect(position.state).toBe("CLOSED");
  expect(event.processedAt).toBeNull();

  await start(context);
  await expect(io.process!(job)).resolves.toEqual({ outcome: "confirmed" });
  await expect(io.process!(job)).resolves.toEqual({ duplicate: true });
  expect(event.processedAt).toBeInstanceOf(Date);
  expect(io.db.transaction).toHaveBeenCalledTimes(1);
  expect(applyPosition).toHaveBeenCalledTimes(1);
  expect(io.enqueueSwap.mock.calls.map(([job]) => [job.key, job.amount])).toEqual([["event", "50"], ["event", "50"]]);
  expect(io.send).not.toHaveBeenCalled();

  // An interruption before a completion record must look up the signature and avoid guessing.
  event.processedAt = null;
  transaction.status = "submitted";
  Reflect.deleteProperty(transaction.plan, "completion");
  io.signatureStatus.mockResolvedValue("confirmed");
  await expect(io.process!(job)).resolves.toEqual({ outcome: "needs_review" });
  expect(io.signatureStatus).toHaveBeenCalledWith("chain-signature");
  expect(io.send).not.toHaveBeenCalled();
});
