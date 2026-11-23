import { describe, expect, it, vi } from "vitest";
import type { Connection } from "@solana/web3.js";
import type { Signer } from "../signer.js";
import { TxSender } from "./sender.js";

function senderWithStatus(status: unknown, height: number) {
  const getBlockHeight = vi.fn().mockResolvedValue(height);
  const getSignatureStatuses = vi.fn().mockResolvedValue({ value: [status] });
  const sender = new TxSender({ getBlockHeight, getSignatureStatuses } as unknown as Connection, {} as Signer);
  return { sender, getBlockHeight, getSignatureStatuses };
}

describe("swap replacement", () => {
  it("waits for finalized blockhash expiration if the signature is absent", async () => {
    const { sender, getBlockHeight, getSignatureStatuses } = senderWithStatus(null, 100);
    await expect(sender.canReplace("sig", 100)).resolves.toBe(false);
    await expect(sender.canReplace("sig", 99)).resolves.toBe(true);
    await expect(sender.canReplace("sig")).resolves.toBe(false);
    expect(getBlockHeight).toHaveBeenCalledWith("finalized");
    expect(getSignatureStatuses).toHaveBeenCalledWith(["sig"], { searchTransactionHistory: true });
  });

  it("preserves a seen signature unless the failure is finalized", async () => {
    for (const status of [
      { err: null, confirmationStatus: "processed" },
      { err: null, confirmationStatus: "finalized" },
      { err: "failed", confirmationStatus: "confirmed" },
    ]) {
      await expect(senderWithStatus(status, 200).sender.canReplace("sig", 100)).resolves.toBe(false);
    }
    const { sender } = senderWithStatus({ err: "failed", confirmationStatus: "finalized" }, 100);
    await expect(sender.canReplace("sig", 150)).resolves.toBe(true);
  });
});
