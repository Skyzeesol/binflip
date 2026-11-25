// Page getSignaturesForAddress back to the wallet's first transaction.
// Output: data/<wallet>.sigs.jsonl (newest first), resumable.
import fs from "node:fs";
import { rpc } from "./rpc.mjs";
const wallet = process.argv[2];
const file = `data/${wallet}.sigs.jsonl`;
let before;
if (fs.existsSync(file)) {
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
  if (lines.length) before = JSON.parse(lines.at(-1)).signature;
}
const out = fs.createWriteStream(file, { flags: "a" });
let n = 0;
for (;;) {
  const page = await rpc("getSignaturesForAddress", [wallet, { limit: 1000, before }]);
  if (!page.length) break;
  for (const s of page) out.write(JSON.stringify({ signature: s.signature, slot: s.slot, blockTime: s.blockTime, err: s.err ? 1 : 0 }) + "\n");
  n += page.length;
  before = page.at(-1).signature;
  if (n % 10000 < 1000) console.log(n, new Date(page.at(-1).blockTime * 1000).toISOString());
}
out.end();
console.log("done", n);
