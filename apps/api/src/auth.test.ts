import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";
import { NonceStore, SESSION_TTL_MS, loginMessage, signSession, verifySession, verifySignature } from "./auth.js";

const SECRET = "test-secret-at-least-32-characters-long";

describe("sign-in with Solana", () => {
  const kp = Keypair.generate();
  const wallet = kp.publicKey.toBase58();
  const sign = (msg: string, k = kp) => bs58.encode(nacl.sign.detached(new TextEncoder().encode(msg), k.secretKey));

  it("accepts the wallet's own signature, rejects others and tampering", () => {
    const msg = loginMessage(wallet, "n1", "2026-11-22T00:00:00Z", "binflip.local");
    expect(verifySignature(msg, sign(msg), wallet)).toBe(true);
    expect(verifySignature(msg, sign(msg, Keypair.generate()), wallet)).toBe(false);
    expect(verifySignature(msg + "x", sign(msg), wallet)).toBe(false);
    expect(verifySignature(msg, "garbage", wallet)).toBe(false);
  });

  it("nonces are single-use and bound to the wallet", () => {
    const store = new NonceStore();
    const { nonce } = store.issue(wallet);
    expect(store.take(nonce, "someone-else")).toBeNull();
    const { nonce: n2 } = store.issue(wallet);
    expect(store.take(n2, wallet)).not.toBeNull();
    expect(store.take(n2, wallet)).toBeNull(); // replay
  });

  it("sessions verify, expire and cannot be forged", () => {
    const t = signSession("user-1", SECRET, 1_000);
    expect(verifySession(t, SECRET, 2_000)).toBe("user-1");
    expect(verifySession(t, SECRET, 1_000 + SESSION_TTL_MS + 1)).toBeNull();
    expect(verifySession(t, "other-secret-other-secret-other-secret", 2_000)).toBeNull();
    expect(verifySession(t.replace("user-1", "user-2"), SECRET, 2_000)).toBeNull();
  });
});
