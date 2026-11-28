// Flatten every downloaded tx into rows (+ swaps / transfers). Output: data/rows.jsonl, raw units.
//
// Ledger vs positions: a tx can touch several positions. There is ONE row per (signature,
// position), each carrying only that position's own events (in event order). The wallet's
// balance changes (solDelta, tokDelta, fee) belong to the SIGNATURE: they are on the first row
// of the signature only (walletRow: true); the others have them null and walletRow: false, so
// summing solDelta over rows counts every signature once. positionsInTx tells a reader when a
// signature's wallet change cannot be split between positions.
const S = (v) => (v == null ? null : typeof v === "bigint" ? v.toString() : v.constructor?.name === "BN" ? v.toString() : v.toBase58 ? v.toBase58() : v);
const JUP = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

/** Rows for one downloaded tx (see the header). `decode` = decodeMeteoraTx (injectable for tests). */
export function rowsFromTx(tx, WALLET, decode) {
    const keys = [...tx.transaction.message.accountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
    const base = { sig: tx.signature, slot: tx.slot, t: tx.blockTime, err: tx.meta.err ? JSON.stringify(tx.meta.err) : null, fee: tx.meta.fee, cu: tx.meta.computeUnitsConsumed, ver: tx.version };
    const wi = keys.indexOf(WALLET);
    base.solDelta = wi >= 0 ? tx.meta.postBalances[wi] - tx.meta.preBalances[wi] : null;
    base.solPre = wi >= 0 ? tx.meta.preBalances[wi] : null;
    base.signer = keys[0];
    // Several token accounts of one mint: sum pre and post per mint (not "last one wins").
    const tok = {}; for (const b of tx.meta.preTokenBalances ?? []) if (b.owner === WALLET) tok[b.mint] = (tok[b.mint] ?? 0n) - BigInt(b.uiTokenAmount.amount);
    for (const b of tx.meta.postTokenBalances ?? []) if (b.owner === WALLET) tok[b.mint] = (tok[b.mint] ?? 0n) + BigInt(b.uiTokenAmount.amount);
    base.tokDelta = Object.fromEntries(Object.entries(tok).filter(([, v]) => v !== 0n).map(([k, v]) => [k, v.toString()]));
    const progs = new Set(tx.transaction.message.instructions.map((ix) => keys[ix.programIdIndex]));
    let dec = []; try { dec = decode(tx); } catch {}
    const ixs = dec.filter((d) => d.kind === "ix"), evs = dec.filter((d) => d.kind === "event");
    if (!ixs.length) {
      const kind = progs.has(JUP) ? "jup_swap" : [...progs].every((p) => p === "11111111111111111111111111111111" || p.startsWith("ComputeBudget")) ? "transfer" : "other";
      const cps = kind === "transfer" ? keys.map((k, j) => [k, tx.meta.postBalances[j] - tx.meta.preBalances[j]]).filter(([k, d]) => k !== WALLET && d !== 0) : undefined;
      return [{ ...base, kind, progs: [...progs].map((p) => p.slice(0, 6)), cps, walletRow: true, positionsInTx: 0 }];
    }
    const kind = ixs.filter((d) => d.innerIndex === null).map((d) => d.name).join("+") || ixs.map((d) => d.name).join("+");
    const evPos = (e) => S(e.data.position);
    // every position this tx touches, in first-appearance order (instructions, then events)
    const positions = [...new Set([...ixs.map((d) => d.accounts.position), ...evs.map(evPos)].filter(Boolean))];
    const rowsOut = (positions.length ? positions : [null]).map((position, k) => {
      const mine = (d) => position === null || d.accounts?.position === position;
      const myIxs = ixs.filter(mine);
      const myEvs = evs.filter((e) => position === null || evPos(e) === position);
      const row = { ...base, kind, positionsInTx: positions.length, walletRow: k === 0 };
      if (k > 0) { row.solDelta = null; row.tokDelta = null; row.fee = null; }
      const first = myIxs.find((d) => d.accounts.lb_pair || d.accounts.lbPair) ?? ixs.find((d) => d.accounts.lb_pair || d.accounts.lbPair);
      row.pool = (myEvs.find((e) => e.data.lb_pair) ? S(myEvs.find((e) => e.data.lb_pair).data.lb_pair) : null) ?? first?.accounts.lb_pair ?? null;
      row.position = position;
      const rb = myIxs.find((d) => d.name === "rebalance_liquidity");
      if (rb) {
        const p = rb.args.params; row.argActive = p.active_id; row.slip = p.max_active_bin_slippage; row.claim = p.should_claim_fee; row.shrink = p.shrink_mode;
        row.removes = p.removes.map((r) => [r.min_bin_id, r.max_bin_id, r.bps]);
        row.adds = p.adds.map((a) => ({ lo: a.min_delta_id, hi: a.max_delta_id, x0: S(a.x0), y0: S(a.y0), dx: S(a.delta_x), dy: S(a.delta_y), flag: a.bit_flag, fx: a.favor_x_in_active_id }));
        row.maxDepX = S(p.max_deposit_x_amount); row.maxDepY = S(p.max_deposit_y_amount);
      }
      const add = myIxs.find((d) => d.name.startsWith("add_liquidity"));
      if (add) row.addArgs = JSON.parse(JSON.stringify(add.args, (k2, v) => (typeof v === "bigint" ? v.toString() : v?.constructor?.name === "BN" ? v.toString() : v)));
      const init = myIxs.find((d) => d.name.startsWith("initialize_position")); if (init) row.initArgs = { lower: init.args.lower_bin_id, width: init.args.width };
      // amounts are SUMMED over this position's events (a tx can add twice), never overwritten by another position's
      const sum = (k2, v) => { row[k2] = (BigInt(row[k2] ?? 0) + BigInt(S(v) ?? 0)).toString(); };
      for (const e of myEvs) {
        const d = e.data;
        if (e.name === "Rebalancing") {
          Object.assign(row, { active: d.active_bin_id, oldMin: row.oldMin ?? d.old_min_id, oldMax: row.oldMax ?? d.old_max_id, newMin: d.new_min_id, newMax: d.new_max_id });
          sum("xW", d.x_withdrawn_amount); sum("yW", d.y_withdrawn_amount); sum("xA", d.x_added_amount); sum("yA", d.y_added_amount); sum("xF", d.x_fee_amount); sum("yF", d.y_fee_amount);
        } else if (e.name === "AddLiquidity") { row.active = d.active_bin_id; sum("addX", d.amounts[0]); sum("addY", d.amounts[1]); }
        else if (e.name === "RemoveLiquidity") { row.active = d.active_bin_id; sum("remX", d.amounts[0]); sum("remY", d.amounts[1]); }
        else if (e.name === "ClaimFee" || e.name === "ClaimFee2") { sum("feeX", d.fee_x); sum("feeY", d.fee_y); }
        else if (e.name === "PositionCreate") row.created = true;
        else if (e.name === "PositionClose") row.closed = true;
      }
      return row;
    });
    return rowsOut;
}
