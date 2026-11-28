// node --test research/ilginc/extract.test.mjs — row contract of extractLib (synthetic txs, fake decoder).
import { test } from "node:test";
import assert from "node:assert/strict";
import { rowsFromTx } from "./extractLib.mjs";

const W = "Wallet1111111111111111111111111111111111111";
const tx = (o = {}) => ({
  signature: "SIG", slot: 1, blockTime: 100, version: 0,
  transaction: { message: { accountKeys: [W, "Prog"], instructions: [{ programIdIndex: 1 }] } },
  meta: { err: null, fee: 5000, computeUnitsConsumed: 1, preBalances: [1_000_000, 0], postBalances: [995_000, 0], preTokenBalances: [], postTokenBalances: [], ...o },
});
const tb = (mint, amount, owner = W) => ({ mint, owner, uiTokenAmount: { amount: String(amount) } });

test("two token accounts of one mint, unchanged 100 + 200: no token delta (was a phantom +100)", () => {
  const t = tx({ preTokenBalances: [tb("M", 100), tb("M", 200)], postTokenBalances: [tb("M", 100), tb("M", 200)] });
  const [r] = rowsFromTx(t, W, () => []);
  assert.deepEqual(r.tokDelta, {});
});

test("two positions in one tx: each row carries its own amounts; the wallet change is on one row only", () => {
  const decode = () => [
    { kind: "ix", name: "add_liquidity_by_strategy2", innerIndex: null, accounts: { position: "A", lb_pair: "POOL" }, args: {} },
    { kind: "ix", name: "add_liquidity_by_strategy2", innerIndex: null, accounts: { position: "B", lb_pair: "POOL" }, args: {} },
    { kind: "event", name: "AddLiquidity", data: { position: "A", lb_pair: "POOL", amounts: [0, 111], active_bin_id: 5 } },
    { kind: "event", name: "AddLiquidity", data: { position: "B", lb_pair: "POOL", amounts: [0, 999], active_bin_id: 5 } },
  ];
  const rows = rowsFromTx(tx(), W, decode);
  assert.equal(rows.length, 2);
  const a = rows.find((r) => r.position === "A"), b = rows.find((r) => r.position === "B");
  assert.equal(a.addY, "111");
  assert.equal(b.addY, "999");
  assert.equal(rows.filter((r) => r.walletRow).length, 1);
  assert.equal(rows.reduce((s, r) => s + (r.solDelta ?? 0), 0), -5000); // the signature counted once
  assert.equal(a.positionsInTx, 2);
});
