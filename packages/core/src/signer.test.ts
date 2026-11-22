import { describe, expect, it } from "vitest";
import { DryRunSigner, SigningDisabledError } from "./signer.js";

describe("DryRunSigner", () => {
  it("never signs", async () => {
    const s = new DryRunSigner("11111111111111111111111111111111");
    await expect(s.signMessage(new Uint8Array([1, 2, 3]))).rejects.toBeInstanceOf(
      SigningDisabledError,
    );
  });
});
