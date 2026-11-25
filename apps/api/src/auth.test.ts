import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";
import { LoginGuard, NonceStore, SESSION_TTL_MS, allowedOrigin, loginMessage, signSession, verifySession, verifySignature } from "./auth.js";

const SECRET = "test-secret-at-least-32-characters-long";

describe("sign-in with Solana", () => {
  const kp = Keypair.generate();
  const wallet = kp.publicKey.toBase58();
  const sign = (msg: string, k = kp) => bs58.encode(nacl.sign.detached(new TextEncoder().encode(msg), k.secretKey));

  it("accepts the wallet's own signature, rejects others and tampering", () => {
    const msg = loginMessage(wallet, "n1", "2026-11-22T00:00:00Z", "https://binflip.tail1.ts.net");
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

  it("message is standard SIWS: host as domain, ASCII statement, required fields", () => {
    const msg = loginMessage(wallet, "abcdef0123456789", "2026-11-22T00:00:00.000Z", "https://binflip.tail1.ts.net");
    const lines = msg.split("\n");
    expect(lines[0]).toBe("binflip.tail1.ts.net wants you to sign in with your Solana account:");
    expect(lines[1]).toBe(wallet);
    expect(lines[3]).toMatch(/^[\x20-\x7e]+$/);
    expect(lines.slice(5)).toEqual([
      "URI: https://binflip.tail1.ts.net",
      "Version: 1",
      "Chain ID: mainnet",
      "Nonce: abcdef0123456789",
      "Issued At: 2026-11-22T00:00:00.000Z",
    ]);
    expect(loginMessage(wallet, "n", "t", "http://localhost:3000").split("\n")[0]).toMatch(/^localhost:3000 wants/);
  });

  it("only allowed origins can get a login message", () => {
    const allowed = ["http://localhost:3000", "https://binflip.tail1.ts.net/"];
    expect(allowedOrigin("https://binflip.tail1.ts.net", allowed)).toBe("https://binflip.tail1.ts.net");
    expect(allowedOrigin("http://localhost:3000/login", allowed)).toBe("http://localhost:3000");
    expect(allowedOrigin("https://evil.example", allowed)).toBeNull();
    expect(allowedOrigin("http://binflip.tail1.ts.net", allowed)).toBeNull();
    expect(allowedOrigin("not a url", allowed)).toBeNull();
  });

  it("nonce remembers the origin it was issued for", () => {
    const store = new NonceStore();
    const { nonce } = store.issue(wallet, "https://binflip.tail1.ts.net");
    expect(store.take(nonce, wallet)?.origin).toBe("https://binflip.tail1.ts.net");
  });

  it("sessions verify, expire and cannot be forged", () => {
    const t = signSession("user-1", SECRET, 3, 1_000);
    expect(verifySession(t, SECRET, 2_000)).toEqual({ userId: "user-1", version: 3 });
    expect(verifySession(t, SECRET, 1_000 + SESSION_TTL_MS + 1)).toBeNull();
    expect(verifySession(t, "other-secret-other-secret-other-secret", 2_000)).toBeNull();
    expect(verifySession(t.replace("user-1", "user-2"), SECRET, 2_000)).toBeNull();
  });
});

describe("login guard", () => {
  it("locks an IP after 5 failures for 15 minutes", () => {
    const g = new LoginGuard();
    for (let i = 0; i < 4; i++) expect(g.fail("1.1.1.1", 1000 + i)).toBeNull();
    expect(g.fail("1.1.1.1", 1005)).toBe("ip");
    expect(g.blockedFor("1.1.1.1", 2000)).toBeGreaterThan(14 * 60_000);
    expect(g.blockedFor("2.2.2.2", 2000)).toBe(0);
    expect(g.blockedFor("1.1.1.1", 1000 + 15 * 60_000 + 1)).toBe(0);
  });
  it("closes password sign-in for everyone after 20 failures in an hour", () => {
    const g = new LoginGuard();
    let r: string | null = null;
    for (let i = 0; i < 20; i++) r = g.fail(`10.0.0.${i}`, 1000 + i);
    expect(r).toBe("global");
    expect(g.blockedFor("9.9.9.9", 5000)).toBeGreaterThan(59 * 60_000);
  });
  it("success clears the IP's failures", () => {
    const g = new LoginGuard();
    for (let i = 0; i < 4; i++) g.fail("1.1.1.1", 1000 + i);
    g.success("1.1.1.1");
    expect(g.fail("1.1.1.1", 1010)).toBeNull();
  });
});
