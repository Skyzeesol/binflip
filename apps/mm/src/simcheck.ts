import { Keypair, PublicKey, VersionedTransaction, type Transaction } from "@solana/web3.js";
import { createRequire } from "node:module";
import { BorshCoder, type Idl } from "@coral-xyz/anchor";
import bs58 from "bs58";

const require = createRequire(import.meta.url);
const coder = new BorshCoder((require("@meteora-ag/dlmm") as { IDL: Idl }).IDL);
const EVENT_TAG = Buffer.from("e445a52e51cb9a1d", "hex");

/** Simulate with inner instructions and decode the DLMM events the program emitted (emit_cpi). */
async function simEvents(tx: Transaction): Promise<Array<{ name: string; data: Record<string, unknown> }>> {
  const vtx = new VersionedTransaction(tx.compileMessage());
  const res = await conn.simulateTransaction(vtx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed", innerInstructions: true });
  const out: Array<{ name: string; data: Record<string, unknown> }> = [];
  for (const group of (res.value as { innerInstructions?: Array<{ instructions: Array<{ data: string }> }> }).innerInstructions ?? []) {
    for (const ix of group.instructions) {
      if (typeof ix.data !== "string") continue; // parsed (non-DLMM) instructions have no raw data
      const raw = Buffer.from(bs58.decode(ix.data));
      if (raw.length < 16 || !raw.subarray(0, 8).equals(EVENT_TAG)) continue;
      const ev = coder.events.decode(raw.subarray(8).toString("base64"));
      if (ev) out.push({ name: ev.name, data: ev.data as Record<string, unknown> });
    }
  }
  return out;
}
import {
  DlmmTxBuilder,
  SolanaRpc,
  TxSender,
  createConnection,
  decodeMeteoraTx,
  mmAddsAt,
  mmDecide,
  mmPlace,
  mmRangeAfter,
  type DecodedEvent,
  type Signer,
} from "@binflip/core";

/**
 * Mainnet dry check of the live mm transactions, built for a REAL open position of the
 * leader and simulated as the leader (sigVerify off, nothing is signed or sent):
 *   1) our rebalance (engine + mmAddsAt) of the leader's position to the current active bin
 *   2) opening a new 0.1 SOL position next to the active bin in the same pool
 *   3) closing the leader's position (remove 100% + claim + close)
 * Usage: node apps/mm/dist/simcheck.js [leader]   (SOLANA_RPC_URL optional)
 */
const LEADER = process.argv[2] ?? "BviQcBvnWv5HHxHcouTwRFhrAMPNKuMLzEaSuxCuv6eU";
const rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const conn = createConnection(rpcUrl);
const rpc = new SolanaRpc(rpcUrl);
const owner = new PublicKey(LEADER);
const asLeader: Signer = { publicKey: LEADER, signMessage: async () => { throw new Error("simulation only"); } } as unknown as Signer;
const builder = new DlmmTxBuilder(conn, owner);
const sender = new TxSender(conn, asLeader);
const str = (v: unknown) => (v && typeof (v as { toBase58?: () => string }).toBase58 === "function" ? (v as { toBase58: () => string }).toBase58() : String(v));

async function sim(label: string, txs: Transaction[]): Promise<boolean> {
  let ok = true;
  for (const [i, tx] of txs.entries()) {
    try {
      await sender.prepare(tx);
      await sender.fitComputeLimit(tx); // simulates with the max limit, then sets ours
      const r = await sender.simulate(tx);
      console.log(`  ✓ ${label}${txs.length > 1 ? ` [${i + 1}/${txs.length}]` : ""}: ${r.unitsConsumed} CU`);
    } catch (err) {
      ok = false;
      const logs = (err as { logs?: string[] }).logs ?? [];
      console.log(`  ✗ ${label}: ${(err as Error).message}\n    ${logs.filter((l) => /Error|error|failed/.test(l)).slice(-3).join("\n    ")}`);
    }
  }
  return ok;
}

// 1) Find an open leader position: the newest successful rebalance whose position is not closed since.
const sigs = await rpc.getSignaturesForAddress(LEADER, { limit: 300 });
let target: { pool: string; position: string; lower: number; upper: number } | null = null;
const closed = new Set<string>();
for (const s of sigs) {
  if (s.err) continue;
  const tx = await rpc.getTransaction(s.signature);
  if (!tx) continue;
  const evs = decodeMeteoraTx(tx).filter((d): d is DecodedEvent => d.kind === "event");
  for (const e of evs) if (e.name === "PositionClose") closed.add(str(e.data.position));
  const rb = evs.find((e) => e.name === "Rebalancing");
  if (rb && !closed.has(str(rb.data.position))) {
    target = { pool: str(rb.data.lb_pair), position: str(rb.data.position), lower: Number(rb.data.new_min_id), upper: Number(rb.data.new_max_id) };
    break;
  }
}
if (!target) throw new Error("no open leader position found in the last 300 transactions");
const info = await builder.poolInfo(target.pool);
const pos = await builder.position(target.pool, target.position);
const range = { lower: pos.positionData.lowerBinId, upper: pos.positionData.upperBinId };
console.log(`pool ${target.pool} (bin step ${info.binStep}), active ${info.activeBinId}, leader position ${target.position} [${range.lower}, ${range.upper}]`);

let allOk = true;
// 1) rebalance to the current active bin with OUR planner (even if the engine would hold: we force the move)
const removes = [{ minBinId: range.lower, maxBinId: range.upper, bps: 10_000 }];
const held = await builder.simulateWithdraw(target.pool, target.position, removes);
const decision = mmDecide({ ...range, side: held.x > 0n ? "token" : "sol" }, info.activeBinId, info.binStep);
// A forced move of an in-range (mixed) position: its contents change with every swap, so leave a
// wider margin than live (where the engine only moves fully one-sided positions).
const adds = mmAddsAt(held.x, held.y, info.binStep, info.activeBinId, decision.kind === "rebalance" ? undefined : 0.98);
console.log(`holds x=${held.x} y=${held.y}; engine says: ${decision.kind}${decision.kind === "rebalance" ? "" : " (forcing a move anyway for the check)"}; new range ${JSON.stringify(mmRangeAfter(adds, info.activeBinId))}`);
const rb = await builder.rebalanceOne({ pool: target.pool, position: target.position, removes, adds, favorX: false, claimFee: true, maxActiveBinSlippage: 0, slippagePct: 1 });
console.log(`  SDK plan: withdraw x=${rb.withdrawn.x} y=${rb.withdrawn.y} → deposit x=${rb.deposited.x} y=${rb.deposited.y}`);
allOk = (await sim("rebalance", rb.txs as Transaction[])) && allOk;
for (const tx of rb.txs as Transaction[]) {
  for (const e of await simEvents(tx)) {
    if (e.name !== "Rebalancing") continue;
    const d = e.data, n = (k: string) => BigInt(String(d[k]));
    console.log(`  program event: withdrawn x=${n("x_withdrawn_amount")} y=${n("y_withdrawn_amount")} → added x=${n("x_added_amount")} y=${n("y_added_amount")}; fee x=${n("x_fee_amount")} y=${n("y_fee_amount")}; new range [${d.new_min_id}, ${d.new_max_id}]`);
    const xw = n("x_withdrawn_amount"), yw = n("y_withdrawn_amount");
    const xOk = n("x_added_amount") <= xw && n("x_added_amount") * 100n >= xw * 97n;
    const yOk = n("y_added_amount") <= yw && n("y_added_amount") * 100n >= yw * 97n;
    console.log(`  ${xOk && yOk ? "✓" : "✗"} re-deposited ≥97% of what was withdrawn on each side, never more`);
    allOk = allOk && xOk && yOk;
  }
}

// 2) open a fresh 0.1 SOL position next to the active bin
const r = mmPlace("sol", info.activeBinId, info.binStep);
const open = await builder.open({ pool: target.pool, lowerBinId: r.lower, upperBinId: r.upper, amountSol: 100_000_000n, strategy: "spot", slippagePct: 1 });
allOk = (await sim(`open 0.1 SOL [${r.lower}, ${r.upper}]`, open.txs as Transaction[])) && allOk;

// 3) close the leader's position
const close = await builder.remove({ pool: target.pool, position: target.position, bps: 10_000, close: true });
allOk = (await sim("close (remove 100% + claim + close)", close.txs as Transaction[])) && allOk;

void Keypair;
console.log(allOk ? "\nALL SIMULATIONS PASSED" : "\nSOME SIMULATIONS FAILED");
process.exit(allOk ? 0 : 1);
