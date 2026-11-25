import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
// Default import: tweetnacl is CommonJS, so in Node ESM it has no named exports (`{ sign }` is undefined).
import nacl from "tweetnacl";
import type { Signer } from "./signer.js";

/**
 * Encrypted agent-wallet keystore (HANDOFF §6): the secret key exists in
 * plaintext only in memory. On disk: scrypt-derived key + AES-256-GCM.
 * The passphrase comes from a file (Docker secret), never from .env or logs.
 */
export interface KeystoreFile {
  version: 1;
  publicKey: string;
  kdf: { name: "scrypt"; N: number; r: number; p: number; salt: string };
  cipher: { name: "aes-256-gcm"; iv: string; tag: string };
  ciphertext: string;
  createdAt: string;
}

const SCRYPT = { N: 2 ** 17, r: 8, p: 1 };
const MIN_PASSPHRASE = 12;

export class KeystoreError extends Error {
  override name = "KeystoreError";
}

export function encryptKeypair(kp: Keypair, passphrase: string): KeystoreFile {
  if (passphrase.length < MIN_PASSPHRASE) {
    throw new KeystoreError(`passphrase must be at least ${MIN_PASSPHRASE} characters`);
  }
  const salt = randomBytes(32);
  const iv = randomBytes(12);
  const key = derive(passphrase, salt, SCRYPT);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(kp.publicKey.toBase58()));
  const ciphertext = Buffer.concat([cipher.update(kp.secretKey), cipher.final()]);
  key.fill(0);
  return {
    version: 1,
    publicKey: kp.publicKey.toBase58(),
    kdf: { name: "scrypt", ...SCRYPT, salt: salt.toString("base64") },
    cipher: { name: "aes-256-gcm", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") },
    ciphertext: ciphertext.toString("base64"),
    createdAt: new Date().toISOString(),
  };
}

export function decryptKeystore(file: KeystoreFile, passphrase: string): Keypair {
  if (file.version !== 1) throw new KeystoreError(`unsupported keystore version ${file.version}`);
  const key = derive(passphrase, Buffer.from(file.kdf.salt, "base64"), file.kdf);
  try {
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(file.cipher.iv, "base64"));
    d.setAAD(Buffer.from(file.publicKey));
    d.setAuthTag(Buffer.from(file.cipher.tag, "base64"));
    const secret = Buffer.concat([d.update(Buffer.from(file.ciphertext, "base64")), d.final()]);
    // Keypair keeps a reference to the array it is given: hand it a copy, wipe ours.
    const kp = Keypair.fromSecretKey(Uint8Array.from(secret));
    secret.fill(0);
    if (kp.publicKey.toBase58() !== file.publicKey) throw new KeystoreError("public key mismatch");
    return kp;
  } catch (err) {
    if (err instanceof KeystoreError) throw err;
    throw new KeystoreError("wrong passphrase or corrupted keystore");
  } finally {
    key.fill(0);
  }
}

function derive(passphrase: string, salt: Buffer, p: { N: number; r: number; p: number }): Buffer {
  return scryptSync(passphrase.normalize("NFKC"), salt, 32, { N: p.N, r: p.r, p: p.p, maxmem: 256 * 1024 * 1024 });
}

/** Read a passphrase from a secret file, trimming one trailing newline. */
export function readPassphraseFile(path: string): string {
  return readFileSync(path, "utf8").replace(/\r?\n$/, "");
}

/** Signer backed by a decrypted keystore. The keypair never leaves this object. */
export class KeystoreSigner implements Signer {
  readonly publicKey: string;
  readonly #kp: Keypair;

  constructor(kp: Keypair) {
    this.#kp = kp;
    this.publicKey = kp.publicKey.toBase58();
  }

  static fromFile(keystorePath: string, passphrase: string): KeystoreSigner {
    const file = JSON.parse(readFileSync(keystorePath, "utf8")) as KeystoreFile;
    return new KeystoreSigner(decryptKeystore(file, passphrase));
  }

  async signMessage(message: Uint8Array): Promise<Uint8Array> {
    return nacl.sign.detached(message, this.#kp.secretKey);
  }

  /** Sign and verify a random message: proves the key and the signing code work before any real transaction. */
  async selfTest(): Promise<void> {
    const msg = randomBytes(64);
    const sig = await this.signMessage(msg);
    if (!nacl.sign.detached.verify(msg, sig, this.#kp.publicKey.toBytes())) throw new Error("agent wallet self-test signature did not verify");
  }

  /** Avoid leaking the key through util.inspect / JSON. */
  toJSON() {
    return { publicKey: this.publicKey };
  }
  [Symbol.for("nodejs.util.inspect.custom")]() {
    return `KeystoreSigner(${this.publicKey})`;
  }
}

export const shortKey = (k: string) => `${k.slice(0, 4)}…${k.slice(-4)}`;
export const encodeBase58 = (b: Uint8Array) => bs58.encode(b);
