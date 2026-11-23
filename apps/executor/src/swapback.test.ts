import { expect, it, vi } from "vitest";
import { startSwapBack } from "./swapback.js";
import { TxSender } from "../../../packages/core/src/solana/sender.js";
import { txs } from "../../../packages/db/src/schema.js";
import type { SwapBackJob } from "@binflip/core";

const io = vi.hoisted(() => ({
  quote: vi.fn(),
  process: null as null | ((job: { data: SwapBackJob }) => Promise<unknown>),
}));
vi.mock("@binflip/core", async () => ({
  ...await import("../../../packages/core/src/index.js"),
  JupiterClient: class {
    quoteToSol = io.quote;
    buildSwap = async () => ({ tx: {}, lastValidBlockHeight: 120 });
  },
}));
vi.mock("@binflip/db", async () => ({ schema: await import("../../../packages/db/src/schema.js") }));
vi.mock("bullmq", () => ({
  Queue: class { close = async () => undefined; },
  Worker: class {
    constructor(_queue: string, process: typeof io.process) { io.process = process; }
    on() {}
    close = async () => undefined;
  },
}));

it("keeps the original Jupiter signature after a confirmation timeout and settles it without a second sale", async () => {
  const row = { id: "swap", status: "planned", signature: null, plan: null, solDelta: null };
  const db = {
    select: () => ({ from: (table: unknown) => ({ where: async () => table === txs ? [row] : [] }) }),
    update: () => ({ set: (patch: object) => ({ where: async () => Object.assign(row, patch) }) }),
  };
  const signatureStatus = vi.fn().mockResolvedValue({ value: [null] });
  const getTransaction = vi.fn().mockResolvedValue({ meta: { preBalances: [100], postBalances: [240] } });
  const connection = {
    getBlockHeight: vi.fn().mockResolvedValue(110),
    getSignatureStatuses: signatureStatus,
    getTransaction,
  };
  const sender = new TxSender(connection as never, {} as never);
  const send = vi.spyOn(sender, "send");
  const submit = vi.spyOn(sender, "sendVersioned").mockImplementation(async (_tx, height, opts) => {
    await opts?.onSignature?.("jupiter-signature", height);
    throw new Error("confirmation timed out");
  });
  const swapTokenToSol = vi.fn();
  io.quote.mockResolvedValue({ outAmount: "150" });
  const swapback = startSwapBack({
    db, sender, connection: {},
    builder: { tokenBalance: async () => 1000n, swapTokenToSol },
    publicKey: "wallet", config: {}, log: { warn: vi.fn() }, notifications: { add: vi.fn() },
    serial: (fn) => fn(),
  } as Parameters<typeof startSwapBack>[0]);
  const data = {
    txId: "swap", key: "event", userId: "user", leaderEventId: "event", positionId: "position",
    mint: "token", pool: "pool", amount: "50", label: "leader",
  };
  try {
    await expect(io.process!({ data })).rejects.toThrow("confirmation timed out");
    expect(row).toMatchObject({ status: "submitted", signature: "jupiter-signature", plan: { lastValidBlockHeight: 120 } });

    await expect(io.process!({ data })).rejects.toThrow("waiting for the previous swap to settle");
    signatureStatus.mockResolvedValue({ value: [{ err: null, confirmationStatus: "confirmed" }] });
    await expect(io.process!({ data })).resolves.toEqual({ route: "Jupiter" });

    expect(row).toMatchObject({ status: "confirmed", solDelta: 140n });
    expect(getTransaction).toHaveBeenCalledWith("jupiter-signature", expect.anything());
    expect(submit).toHaveBeenCalledTimes(1);
    expect(swapTokenToSol).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  } finally {
    await swapback.close();
  }
});
