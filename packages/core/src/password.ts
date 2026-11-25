import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";

/**
 * Panel password hashing: scrypt (memory-hard), random 16-byte salt per hash.
 * Stored as `scrypt$<log2N>$<r>$<p>$<salt b64>$<hash b64>` so parameters can be raised later.
 * The password itself is never stored or logged.
 */
const LOG_N = 17; // N = 131072 → ~128 MB, ~0.3 s per check: slow for guessing, fine for one user
const R = 8;
const P = 1;
const KEYLEN = 32;
export const MIN_PASSWORD_LENGTH = 12;

function scrypt(password: string, salt: Buffer, logN: number, r: number, p: number): Promise<Buffer> {
  const N = 2 ** logN;
  return new Promise((resolve, reject) =>
    scryptCb(password.normalize("NFKC"), salt, KEYLEN, { N, r, p, maxmem: 256 * N * r }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, LOG_N, R, P);
  return ["scrypt", LOG_N, R, P, salt.toString("base64"), key.toString("base64")].join("$");
}

const DUMMY = ["scrypt", LOG_N, R, P, Buffer.alloc(16).toString("base64"), Buffer.alloc(KEYLEN).toString("base64")].join("$");

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  // With no hash (unknown user) still do the work, so timing doesn't reveal whether the username exists.
  const parts = (stored ?? DUMMY).split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, logN, r, p, salt, hash] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(hash, "base64");
  const key = await scrypt(password, Buffer.from(salt, "base64"), Number(logN), Number(r), Number(p));
  return stored !== null && stored !== undefined && key.length === expected.length && timingSafeEqual(key, expected);
}
