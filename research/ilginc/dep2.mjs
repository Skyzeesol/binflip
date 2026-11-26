// SOL re-deposit rule split by what the position was doing before (SOL->SOL move vs coming back from token side).
import fs from "node:fs";
const rows = fs.readFileSync("data/rows.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => !r.err && r.position).sort((a, b) => a.slot - b.slot);
const B = (v) => BigInt(v ?? 0);
const near = (a, b) => (a > b ? a - b : b - a) * 1000n <= (a > b ? a : b);
const byPos = new Map(); for (const r of rows) { const a = byPos.get(r.position) ?? []; a.push(r); byPos.set(r.position, a); }
const c = new Map(); const inc = (k) => c.set(k, (c.get(k) ?? 0) + 1);
for (const [, seq] of byPos) {
  const open = seq.find((r) => r.created); const lot = open ? B(open.addY) : null;
  let prevSide = open ? "SOL" : null;
  for (const r of seq) {
    if (r.kind !== "rebalance_liquidity") continue;
    const xW = B(r.xW), yW = B(r.yW), yA = B(r.yA), xA = B(r.xA);
    const side = xA > 0n ? "TOK" : "SOL";
    if (side === "SOL" && lot) {
      const from = xW > 0n ? "mixW" : prevSide === "TOK" ? "fromTOK" : "SOL->SOL";
      const rule = near(yA, lot) ? "=lot" : near(yA, yW) ? "=withdrawn" : yA > yW ? ">withdrawn" : "<withdrawn";
      inc(`${from.padEnd(9)} ${rule}  ${near(yA, lot) && near(yA, yW) ? "(ikisi de)" : ""}`);
    }
    prevSide = side;
  }
}
console.log([...c].sort((a, b) => b[1] - a[1]));
// Where are yA / yW relative to the open lot in the non-lot cases?
const d = new Map(); const inc2 = (k) => d.set(k, (d.get(k) ?? 0) + 1);
for (const [, seq] of byPos) {
  const open = seq.find((r) => r.created); if (!open) continue; const lot = B(open.addY); if (lot === 0n) continue;
  let prev = "SOL";
  for (const r of seq) {
    if (r.kind !== "rebalance_liquidity") continue;
    const side = B(r.xA) > 0n ? "TOK" : "SOL";
    if (side === "SOL" && !near(B(r.yA), lot)) {
      const yW = B(r.yW), yA = B(r.yA);
      inc2(`${prev === "TOK" ? "fromTOK" : "SOL->SOL"} yW${yW > lot ? ">" : "<"}lot yA${yA > lot ? ">" : "<"}lot yA${near(yA, yW) ? "=" : yA > yW ? ">" : "<"}yW`);
    }
    prev = side;
  }
}
console.log([...d].sort((a, b) => b[1] - a[1]));
