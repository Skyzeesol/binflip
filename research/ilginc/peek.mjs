// Quick structural census of downloaded txs: program/instruction templates, CU, fees.
import fs from "node:fs"; import zlib from "node:zlib";
import { decodeMeteoraTx } from "../../packages/core/dist/meteora/decode.js";
const files = fs.readdirSync("data").filter((f) => f.includes(".tx.") && f.endsWith(".gz"));
const txs = files.flatMap((f) => { try { return zlib.gunzipSync(fs.readFileSync("data/" + f)).toString().trim().split("\n").map((l) => JSON.parse(l)); } catch { return []; } });
const tmpl = new Map(); const COMPUTE = "ComputeBudget111111111111111111111111111111";
for (const tx of txs) {
  const keys = [...tx.transaction.message.accountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
  const progs = tx.transaction.message.instructions.map((ix) => keys[ix.programIdIndex].slice(0, 6));
  const dec = decodeMeteoraTx(tx).filter((d) => d.kind === "ix" && d.innerIndex === null).map((d) => d.name);
  const k = (tx.meta.err ? "FAIL " : "OK   ") + progs.join(",") + " | " + dec.join(",");
  const e = tmpl.get(k) ?? { n: 0, cu: [], fee: [] }; e.n++; e.cu.push(tx.meta.computeUnitsConsumed); e.fee.push(tx.meta.fee); tmpl.set(k, e);
}
const med = (a) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
console.log("txs", txs.length, "LUT used:", txs.filter((t) => t.transaction.message.addressTableLookups?.length).length);
for (const [k, e] of [...tmpl].sort((a, b) => b[1].n - a[1].n).slice(0, 15)) console.log(String(e.n).padStart(5), "cu~" + med(e.cu), "fee~" + med(e.fee), k);
