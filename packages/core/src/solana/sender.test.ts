import { describe, expect, it } from "vitest";
import { TxSender } from "./sender.js";

// resolve(): the single outcome rule for opens, closes and sales (fake connection, nothing sent)
function sender(o: { statuses: Array<null | { err: unknown; confirmationStatus: string }>; height: number }) {
  let i = 0;
  const conn = {
    getSignatureStatuses: async () => ({ value: [o.statuses[Math.min(i++, o.statuses.length - 1)]] }),
    getBlockHeight: async () => o.height,
  };
  return new TxSender(conn as never, { publicKey: "x" } as never);
}
const ok = { err: null, confirmationStatus: "confirmed" };

describe("TxSender.resolve", () => {
  it("confirmed / failed as the chain says", async () => {
    expect(await sender({ statuses: [ok], height: 0 }).resolve("s", 10)).toBe("confirmed");
    expect(await sender({ statuses: [{ err: { x: 1 }, confirmationStatus: "confirmed" }], height: 0 }).resolve("s", 10)).toBe("failed");
  });
  it("unseen within its validity window → pending (wait), never expired", async () => {
    expect(await sender({ statuses: [null], height: 10 }).resolve("s", 10)).toBe("pending");
  });
  it("unseen past its last valid block height, twice → expired", async () => {
    expect(await sender({ statuses: [null, null], height: 11 }).resolve("s", 10)).toBe("expired");
  });
  it("found on the second look past the height → its real outcome, not expired", async () => {
    expect(await sender({ statuses: [null, ok], height: 11 }).resolve("s", 10)).toBe("confirmed");
  });
  it("no last valid block height recorded → pending forever (no time-based guess)", async () => {
    expect(await sender({ statuses: [null], height: 1e9 }).resolve("s", undefined)).toBe("pending");
  });
  it("processed-only counts as not yet known", async () => {
    expect(await sender({ statuses: [{ err: null, confirmationStatus: "processed" }], height: 5 }).resolve("s", 10)).toBe("pending");
  });
  it("processed on both looks past the last valid height → pending, never expired", async () => {
    const proc = { err: null, confirmationStatus: "processed" };
    expect(await sender({ statuses: [proc, proc], height: 11 }).resolve("s", 10)).toBe("pending");
  });
  it("not found first, processed on the second look past the height → pending", async () => {
    expect(await sender({ statuses: [null, { err: null, confirmationStatus: "processed" }], height: 11 }).resolve("s", 10)).toBe("pending");
  });
  it("processed WITH an error is not final: pending, also past the last valid height", async () => {
    const procErr = { err: { InstructionError: [0, "Custom"] }, confirmationStatus: "processed" };
    expect(await sender({ statuses: [procErr], height: 5 }).resolve("s", 10)).toBe("pending");
    expect(await sender({ statuses: [procErr, procErr], height: 11 }).resolve("s", 10)).toBe("pending");
    expect(await sender({ statuses: [procErr], height: 5 }).status("s")).toBe("unknown");
  });
  it("confirmed with an error → failed", async () => {
    expect(await sender({ statuses: [{ err: { x: 1 }, confirmationStatus: "finalized" }], height: 0 }).resolve("s", 10)).toBe("failed");
  });
});
