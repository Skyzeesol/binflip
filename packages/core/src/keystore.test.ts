import { inspect } from "node:util";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";
import { KeystoreError, KeystoreSigner, decryptKeystore, encryptKeypair } from "./keystore.js";

const PASS = "correct horse battery staple";

describe("keystore", () => {
  const kp = Keypair.generate();
  const file = encryptKeypair(kp, PASS);

  it("round-trips and never stores the secret in clear", () => {
    expect(decryptKeystore(file, PASS).publicKey.toBase58()).toBe(kp.publicKey.toBase58());
    const raw = JSON.stringify(file);
    expect(raw).not.toContain(Buffer.from(kp.secretKey).toString("base64"));
  });

  it("rejects a wrong passphrase", () => {
    expect(() => decryptKeystore(file, "wrong passphrase!!")).toThrow(KeystoreError);
  });

  it("rejects tampering (public key is authenticated)", () => {
    const other = Keypair.generate().publicKey.toBase58();
    expect(() => decryptKeystore({ ...file, publicKey: other }, PASS)).toThrow(KeystoreError);
  });

  it("refuses short passphrases", () => {
    expect(() => encryptKeypair(kp, "short")).toThrow(/at least/);
  });

  it("signer produces valid ed25519 signatures and does not leak the key", async () => {
    const s = new KeystoreSigner(decryptKeystore(file, PASS));
    const msg = new TextEncoder().encode("hello");
    const sig = await s.signMessage(msg);
    expect(nacl.sign.detached.verify(msg, sig, kp.publicKey.toBytes())).toBe(true);
    expect(JSON.stringify(s)).not.toContain("secret");
    expect(inspect(s)).toBe(`KeystoreSigner(${kp.publicKey.toBase58()})`);
  });
}, 30_000);
