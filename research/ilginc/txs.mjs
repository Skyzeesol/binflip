// Download full transactions for a wallet's signature list. Crash-safe and resumable:
// each tx is appended as its own gzip member (a multi-member .gz is still valid gzip),
// and "done" is rebuilt from what is actually on disk.
// Usage: node txs.mjs <wallet> [concurrency]
import fs from "node:fs"; import zlib from "node:zlib";
import { gzLines } from "./gzlines.mjs";
import { rpc, sleep } from "./rpc.mjs";
const [wallet, conc = "5"] = process.argv.slice(2);
const sigs = fs.readFileSync(`data/${wallet}.sigs.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const done = new Set();
for (const f of fs.readdirSync("data").filter((f) => f.startsWith(wallet + ".tx.") && f.endsWith(".gz"))) {
  for await (const line of gzLines("data/" + f)) { const m = line.match(/"signature":"([^"]+)"/); if (m) done.add(m[1]); }
}
const todo = sigs.filter((s) => !done.has(s.signature));
console.log("have", done.size, "todo", todo.length);
const fd = fs.openSync(`data/${wallet}.tx.${Date.now()}.jsonl.gz`, "a");
let i = 0, ok = 0, missing = 0; const t0 = Date.now();
async function worker() {
  while (i < todo.length) {
    const s = todo[i++];
    let tx = null;
    for (let k = 0; k < 5 && !tx; k++) { tx = await rpc("getTransaction", [s.signature, { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "finalized" }]); if (!tx) await sleep(2000); }
    if (!tx) { missing++; continue; }
    fs.writeSync(fd, zlib.gzipSync(JSON.stringify({ signature: s.signature, ...tx }) + "\n"));
    if (++ok % 1000 === 0) console.log(new Date().toISOString(), ok, "/", todo.length, ((ok / (Date.now() - t0)) * 1000).toFixed(1), "tx/s", "missing", missing);
  }
}
await Promise.all(Array.from({ length: +conc }, worker));
fs.closeSync(fd);
console.log("done", ok, "missing", missing);
