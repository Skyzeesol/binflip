// Flatten every downloaded tx into one row per Meteora action (+ swaps / transfers).
// Output: data/rows.jsonl. Amounts as strings (raw units).
import fs from "node:fs"; import zlib from "node:zlib";
import { decodeMeteoraTx } from "../../packages/core/dist/meteora/decode.js";
const WALLET = process.argv[2];
const S = (v) => (v == null ? null : typeof v === "bigint" ? v.toString() : v.constructor?.name === "BN" ? v.toString() : v.toBase58 ? v.toBase58() : v);
const out = fs.createWriteStream("data/rows.jsonl");
const JUP = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const WSOL = "So11111111111111111111111111111111111111112";
let n = 0;
for (const f of fs.readdirSync("data").filter((f) => f.includes(".tx.") && f.endsWith(".gz")).sort()) {
  let text; try { text = zlib.gunzipSync(fs.readFileSync("data/" + f), { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString(); } catch (e) { console.error("skip", f, e.message); continue; }
  for (const line of text.split("\n")) {
    if (!line) continue; let tx; try { tx = JSON.parse(line); } catch { continue; }
    const keys = [...tx.transaction.message.accountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
    const base = { sig: tx.signature, slot: tx.slot, t: tx.blockTime, err: tx.meta.err ? JSON.stringify(tx.meta.err) : null, fee: tx.meta.fee, cu: tx.meta.computeUnitsConsumed, ver: tx.version };
    const wi = keys.indexOf(WALLET);
    base.solDelta = wi >= 0 ? tx.meta.postBalances[wi] - tx.meta.preBalances[wi] : null;
    base.solPre = wi >= 0 ? tx.meta.preBalances[wi] : null;
    base.signer = keys[0];
    const tok = {}; for (const b of tx.meta.preTokenBalances ?? []) if (b.owner === WALLET) tok[b.mint] = -BigInt(b.uiTokenAmount.amount);
    for (const b of tx.meta.postTokenBalances ?? []) if (b.owner === WALLET) tok[b.mint] = (tok[b.mint] ?? 0n) + BigInt(b.uiTokenAmount.amount);
    base.tokDelta = Object.fromEntries(Object.entries(tok).filter(([, v]) => v !== 0n).map(([k, v]) => [k, v.toString()]));
    const progs = new Set(tx.transaction.message.instructions.map((ix) => keys[ix.programIdIndex]));
    let dec = []; try { dec = decodeMeteoraTx(tx); } catch {}
    const ixs = dec.filter((d) => d.kind === "ix"), evs = dec.filter((d) => d.kind === "event");
    if (!ixs.length) {
      const kind = progs.has(JUP) ? "jup_swap" : [...progs].every((p) => p === "11111111111111111111111111111111" || p.startsWith("ComputeBudget")) ? "transfer" : "other";
      const cps = kind === "transfer" ? keys.map((k, j) => [k, tx.meta.postBalances[j] - tx.meta.preBalances[j]]).filter(([k, d]) => k !== WALLET && d !== 0) : undefined;
      out.write(JSON.stringify({ ...base, kind, progs: [...progs].map((p) => p.slice(0, 6)), cps }) + "\n"); n++; continue;
    }
    const row = { ...base, kind: ixs.filter((d) => d.innerIndex === null).map((d) => d.name).join("+") || ixs.map((d) => d.name).join("+") };
    const first = ixs.find((d) => d.accounts.lb_pair || d.accounts.lbPair);
    row.pool = first?.accounts.lb_pair ?? null; row.position = ixs.find((d) => d.accounts.position)?.accounts.position ?? null;
    const rb = ixs.find((d) => d.name === "rebalance_liquidity");
    if (rb) {
      const p = rb.args.params; row.argActive = p.active_id; row.slip = p.max_active_bin_slippage; row.claim = p.should_claim_fee; row.shrink = p.shrink_mode;
      row.removes = p.removes.map((r) => [r.min_bin_id, r.max_bin_id, r.bps]);
      row.adds = p.adds.map((a) => ({ lo: a.min_delta_id, hi: a.max_delta_id, x0: S(a.x0), y0: S(a.y0), dx: S(a.delta_x), dy: S(a.delta_y), flag: a.bit_flag, fx: a.favor_x_in_active_id }));
      row.maxDepX = S(p.max_deposit_x_amount); row.maxDepY = S(p.max_deposit_y_amount);
    }
    const add = ixs.find((d) => d.name.startsWith("add_liquidity"));
    if (add) row.addArgs = JSON.parse(JSON.stringify(add.args, (k, v) => (typeof v === "bigint" ? v.toString() : v?.constructor?.name === "BN" ? v.toString() : v)));
    const init = ixs.find((d) => d.name.startsWith("initialize_position")); if (init) row.initArgs = { lower: init.args.lower_bin_id, width: init.args.width };
    for (const e of evs) {
      const d = e.data;
      if (e.name === "Rebalancing") Object.assign(row, { active: d.active_bin_id, oldMin: d.old_min_id, oldMax: d.old_max_id, newMin: d.new_min_id, newMax: d.new_max_id, xW: S(d.x_withdrawn_amount), yW: S(d.y_withdrawn_amount), xA: S(d.x_added_amount), yA: S(d.y_added_amount), xF: S(d.x_fee_amount), yF: S(d.y_fee_amount) });
      else if (e.name === "AddLiquidity") Object.assign(row, { active: d.active_bin_id, addX: S(d.amounts[0]), addY: S(d.amounts[1]) });
      else if (e.name === "RemoveLiquidity") Object.assign(row, { active: d.active_bin_id, remX: S(d.amounts[0]), remY: S(d.amounts[1]) });
      else if (e.name === "ClaimFee" || e.name === "ClaimFee2") Object.assign(row, { feeX: S(d.fee_x), feeY: S(d.fee_y) });
      else if (e.name === "PositionCreate") row.created = true;
      else if (e.name === "PositionClose") row.closed = true;
    }
    out.write(JSON.stringify(row) + "\n"); n++;
  }
}
out.end(); console.log("rows", n);
