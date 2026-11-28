// Attribution of a token's swaps (inside a position's or chain's window) to that position/chain.
// Buys and sells are NOT netted: a buy of the same token in the window means the wallet sourced
// tokens outside the LP, so the window's sales cannot be attributed to the LP (status "external_buy").
//   received: tokens the LP position(s) gave us (Σ positive tokDelta of the position txs)
//   left:     Σ tokDelta of the position txs (LP in − LP out)
//   swaps:    swap rows of the window touching the mint: { solDelta, tok (BigInt delta) }
export function attribute(received, left, swaps) {
  let soldTok = 0n, boughtTok = 0n, soldLamports = 0;
  for (const s of swaps) {
    if (s.tok > 0n) boughtTok += s.tok;
    else if (s.tok < 0n) { soldTok -= s.tok; soldLamports += s.solDelta; }
  }
  if (boughtTok > 0n) return { status: "external_buy", soldTok, boughtTok, soldLamports };
  const rest = left - soldTok;
  // more than 0.5% of what the LP gave still in the wallet: realized result incomplete
  if (rest > 0n && rest * 200n > received) return { status: "unsold", soldTok, boughtTok, soldLamports };
  // sold more than the LP gave (+0.5%): the sales also cleared other positions' tokens
  if (soldTok * 200n > received * 201n) return { status: "mixed", soldTok, boughtTok, soldLamports };
  return { status: "ok", soldTok, boughtTok, soldLamports };
}
