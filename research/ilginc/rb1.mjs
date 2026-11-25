import fs from "node:fs"; import zlib from "node:zlib";
import { decodeMeteoraTx } from "../../packages/core/dist/meteora/decode.js";
const f = fs.readdirSync("data").filter((f) => f.includes(".tx.") && f.endsWith(".gz"))[0];
const txs = zlib.gunzipSync(fs.readFileSync("data/" + f)).toString().trim().split("\n").map((l) => JSON.parse(l));
const big = (v) => (v && typeof v === "object" && "toString" in v && !Array.isArray(v) ? v.toString() : v);
const show = (o) => JSON.stringify(o, (k, v) => typeof v === "bigint" ? v.toString() : (v && v.constructor?.name === "BN") ? v.toString() : (v && v.constructor?.name === "PublicKey") ? v.toBase58() : v);
let shown = 0;
for (const tx of txs) {
  if (tx.meta.err) continue;
  const d = decodeMeteoraTx(tx);
  if (!d.some((x) => x.name === "rebalance_liquidity")) continue;
  for (const x of d) console.log(x.kind, x.name, show(x.kind === "ix" ? x.args : x.data).slice(0, 900));
  console.log("version", tx.version, "fee", tx.meta.fee, "cu", tx.meta.computeUnitsConsumed, "\n---");
  if (++shown >= 2) break;
}
