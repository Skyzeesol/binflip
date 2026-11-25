import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import bs58 from "bs58";
import nacl from "tweetnacl";

/**
 * Sign-In With Solana, minimal and dependency-light:
 *   1. client asks for a nonce for its wallet
 *   2. wallet signs `loginMessage(wallet, nonce, issuedAt, origin)` (Phantom signMessage)
 *   3. server verifies the ed25519 signature, the nonce (single use, 5 min) and
 *      that the wallet is a registered login wallet, then issues a session cookie.
 * The session is an HMAC-signed token, so the API stays stateless.
 */

const NONCE_TTL_MS = 5 * 60_000;
export const SESSION_TTL_MS = 7 * 24 * 3600_000;

/**
 * Standard SIWS / EIP-4361 text, so wallets (Phantom mobile is strict) accept it:
 * the domain must equal the page's host and the statement must be ASCII.
 */
export function loginMessage(wallet: string, nonce: string, issuedAt: string, origin: string): string {
  return [
    `${new URL(origin).host} wants you to sign in with your Solana account:`,
    wallet,
    "",
    "Binflip paneline giris. Bu imza islem yapmaz ve ucret odemez.",
    "",
    `URI: ${origin}`,
    "Version: 1",
    "Chain ID: mainnet",
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
  ].join("\n");
}

/** Normalised origin (scheme://host[:port]) if it is one of the allowed panel origins. */
export function allowedOrigin(origin: string, allowed: string[]): string | null {
  let o: string;
  try {
    o = new URL(origin).origin;
  } catch {
    return null;
  }
  return allowed.some((a) => a.replace(/\/+$/, "") === o) ? o : null;
}

export class NonceStore {
  private nonces = new Map<string, { wallet: string; origin: string; issuedAt: string; expires: number }>();

  issue(wallet: string, origin = "http://localhost:3000"): { nonce: string; issuedAt: string } {
    this.gc();
    const nonce = randomBytes(16).toString("hex");
    const issuedAt = new Date().toISOString();
    this.nonces.set(nonce, { wallet, origin, issuedAt, expires: Date.now() + NONCE_TTL_MS });
    return { nonce, issuedAt };
  }

  /** Single use: a nonce is consumed whether or not verification succeeds. */
  take(nonce: string, wallet: string): { issuedAt: string; origin: string } | null {
    const n = this.nonces.get(nonce);
    this.nonces.delete(nonce);
    if (!n || n.wallet !== wallet || n.expires < Date.now()) return null;
    return { issuedAt: n.issuedAt, origin: n.origin };
  }

  private gc() {
    const now = Date.now();
    for (const [k, v] of this.nonces) if (v.expires < now) this.nonces.delete(k);
  }
}

export function verifySignature(message: string, signatureB58: string, walletB58: string): boolean {
  try {
    const sig = bs58.decode(signatureB58);
    const pk = bs58.decode(walletB58);
    if (sig.length !== 64 || pk.length !== 32) return false;
    return nacl.sign.detached.verify(new TextEncoder().encode(message), sig, pk);
  } catch {
    return false;
  }
}

/**
 * Session token `userId.version.exp.hmac`. `version` is users.session_version at sign-in;
 * bumping it in the DB (password change, "log out everywhere") invalidates every older token.
 */
export function signSession(userId: string, secret: string, version = 0, now = Date.now()): string {
  const exp = now + SESSION_TTL_MS;
  const body = `${userId}.${version}.${exp}`;
  return `${body}.${hmac(body, secret)}`;
}

export function verifySession(token: string | undefined, secret: string, now = Date.now()): { userId: string; version: number } | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [userId, version, exp, sig] = parts as [string, string, string, string];
  const expected = hmac(`${userId}.${version}.${exp}`, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (Number(exp) < now) return null;
  return { userId, version: Number(version) };
}

/**
 * Brute-force guard for the password sign-in. Per IP: 5 failures in 15 min → that IP waits 15 min.
 * Overall: 20 failures in an hour → password sign-in closed for an hour for everyone (wallet sign-in stays open).
 */
export class LoginGuard {
  private byIp = new Map<string, number[]>();
  private all: number[] = [];
  private globalUntil = 0;
  constructor(
    private readonly ipMax = 5,
    private readonly ipWindowMs = 15 * 60_000,
    private readonly globalMax = 20,
    private readonly globalWindowMs = 60 * 60_000,
  ) {}

  /** Milliseconds this IP still has to wait (0 = may try). */
  blockedFor(ip: string, now = Date.now()): number {
    if (this.globalUntil > now) return this.globalUntil - now;
    const recent = (this.byIp.get(ip) ?? []).filter((t) => now - t < this.ipWindowMs);
    if (recent.length >= this.ipMax) return recent[0]! + this.ipWindowMs - now;
    return 0;
  }

  /** Records a failure; returns "ip" or "global" when this failure triggered a lock. */
  fail(ip: string, now = Date.now()): "ip" | "global" | null {
    const recent = [...(this.byIp.get(ip) ?? []).filter((t) => now - t < this.ipWindowMs), now];
    this.byIp.set(ip, recent);
    this.all = [...this.all.filter((t) => now - t < this.globalWindowMs), now];
    if (this.byIp.size > 10_000) this.byIp.clear();
    if (this.all.length >= this.globalMax) {
      this.globalUntil = now + this.globalWindowMs;
      this.all = [];
      return "global";
    }
    return recent.length === this.ipMax ? "ip" : null;
  }

  success(ip: string) {
    this.byIp.delete(ip);
  }
}

function hmac(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}
