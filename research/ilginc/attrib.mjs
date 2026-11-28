// Attribution of a token's swaps (inside a position's or chain's window) to that position/chain.
// Buys and sells are NOT netted: a buy of the same token in the window means the wallet sourced
// tokens outside the LP, so the window's sales cannot be attributed to the LP (status "external_buy").
//   received: Σ positive tokDelta of the position txs (GROSS: a rebalance that withdraws and
//             re-deposits the same token counts it twice) — kept for reporting only
//   left:     Σ tokDelta of the position txs = NET LP outflow to the wallet. This is the only
//             amount the window's sales can be attributed to.
//   swaps:    swap rows of the window touching the mint: { solDelta, tok (BigInt delta) }
export function attribute(received, left, swaps) {
  let soldTok = 0n, boughtTok = 0n, soldLamports = 0;
  for (const s of swaps) {
    if (s.tok > 0n) boughtTok += s.tok;
    else if (s.tok < 0n) { soldTok -= s.tok; soldLamports += s.solDelta; }
  }
  if (boughtTok > 0n) return { status: "external_buy", soldTok, boughtTok, soldLamports };
  const net = left > 0n ? left : 0n;
  // sold more than the LP's NET outflow (+0.5%): the sales also cleared tokens from elsewhere
  if (soldTok * 200n > net * 201n) return { status: "mixed", soldTok, boughtTok, soldLamports, net };
  const rest = net - soldTok;
  // more than 0.5% of the net outflow still in the wallet: realized result incomplete
  if (rest > 0n && rest * 200n > net) return { status: "unsold", soldTok, boughtTok, soldLamports, net };
  return { status: "ok", soldTok, boughtTok, soldLamports, net };
}
