// Flatten every downloaded tx into rows: see extractLib.mjs for the row contract.
// Output: data/rows.jsonl. Usage: node extract.mjs <wallet>
import fs from "node:fs";
import { gzLines } from "./gzlines.mjs";
import { rowsFromTx } from "./extractLib.mjs";
import { decodeMeteoraTx } from "../../packages/core/dist/meteora/decode.js";
const WALLET = process.argv[2];
const DATA = process.env.DATA_DIR ?? "data";
const out = fs.createWriteStream(`${DATA}/rows.jsonl`);
let n = 0;
for (const f of fs.readdirSync(DATA).filter((f) => f.includes(".tx.") && f.endsWith(".gz")).sort()) {
  for await (const line of gzLines(`${DATA}/${f}`)) {
    let tx; try { tx = JSON.parse(line); } catch { continue; }
    for (const row of rowsFromTx(tx, WALLET, decodeMeteoraTx)) { out.write(JSON.stringify(row) + "\n"); n++; }
  }
}
out.end(); console.log("rows", n);
