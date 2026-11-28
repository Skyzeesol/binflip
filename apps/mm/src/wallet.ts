import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { Keypair } from "@solana/web3.js";
import { decryptKeystore, encryptKeypair } from "@binflip/core";

/**
 * Create the mm bot wallet: a NEW keypair, encrypted (scrypt + AES-256-GCM) with a passphrase
 * typed twice on the TTY, written with mode 0600. Refuses to overwrite. Prints only the public
 * key. There is no import: a main wallet's key never goes on the server.
 *
 *   node apps/mm/dist/wallet.js create --out /keystore/mm.json
 */
const [cmd, flag, out] = process.argv.slice(2);
if (cmd !== "create" || flag !== "--out" || !out) {
  console.error("usage: node apps/mm/dist/wallet.js create --out <path>");
  process.exit(2);
}
if (existsSync(out)) {
  console.error(`${out} already exists; refusing to overwrite a keystore`);
  process.exit(1);
}

function promptSecret(q: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error("no TTY: run with `docker compose run --rm -it ...`");
  return new Promise<string>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const o = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
    let prompted = false;
    o._writeToOutput = (s: string) => {
      if (!prompted) {
        o.output.write(s);
        prompted = true;
      }
    };
    rl.question(q, (a) => {
      rl.close();
      process.stdout.write("\n");
      resolve(a);
    });
  });
}

const a = await promptSecret("Keystore passphrase (min 12 chars): ");
const b = await promptSecret("Repeat: ");
if (a !== b) throw new Error("passphrases do not match");
if (a.length < 12) throw new Error("passphrase must be at least 12 characters");
const kp = Keypair.generate();
const file = encryptKeypair(kp, a);
if (decryptKeystore(file, a).publicKey.toBase58() !== kp.publicKey.toBase58()) throw new Error("round-trip check failed");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(file, null, 2), { mode: 0o600, flag: "wx" });
console.log(`created ${out}\npublic key (send a SMALL amount of SOL here): ${kp.publicKey.toBase58()}`);
