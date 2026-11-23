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

export function signSession(userId: string, secret: string, now = Date.now()): string {
  const exp = now + SESSION_TTL_MS;
  const body = `${userId}.${exp}`;
  return `${body}.${hmac(body, secret)}`;
}

export function verifySession(token: string | undefined, secret: string, now = Date.now()): string | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [userId, exp, sig] = parts as [string, string, string];
  const expected = hmac(`${userId}.${exp}`, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (Number(exp) < now) return null;
  return userId;
}

function hmac(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}
