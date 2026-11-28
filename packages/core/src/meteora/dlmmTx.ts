import { createRequire } from "node:module";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import BN from "bn.js";
import { WSOL_MINT } from "../constants.js";
import type { Strategy } from "./strategy.js";

// The SDK's ESM build is broken under Node (see decode.ts); its CJS export is the DLMM class.
const require = createRequire(import.meta.url);
type DLMMModule = typeof import("@meteora-ag/dlmm");
type DLMMClass = DLMMModule["default"];
type DLMMInstance = Awaited<ReturnType<DLMMClass["create"]>>;
type LbPosition = Awaited<ReturnType<DLMMInstance["getPosition"]>>;
const DLMM = require("@meteora-ag/dlmm") as DLMMClass & DLMMModule;

/** Bins one add can cover; wider ranges go through extended positions + chunked adds. */
const MAX_BINS_SIMPLE = 70;

export interface BuiltTxs {
  /** In order; each must confirm before the next is sent. */
  txs: Transaction[];
  /** Extra signers per tx index (the fresh position keypair on open). */
  extraSigners: Map<number, Keypair[]>;
  /** Our position address, when this build creates or targets one. */
  position: string | null;
  /** The bin range the SDK actually built for (after clipping to the active bin), when known. */
  range?: { lower: number; upper: number };
  /** The active bin the SDK built against (it refetches the pool), when known. */
  activeId?: number;
}

export interface PoolInfo {
  pool: string;
  mintX: string;
  mintY: string;
  binStep: number;
  activeBinId: number;
  solIsY: boolean;
}

const STRATEGY_TYPE: Record<Exclude<Strategy, "custom">, number> = { spot: 0, curve: 1, bid_ask: 2 };

/**
 * Builds Meteora DLMM transactions for our agent wallet via the official SDK.
 * Single-sided SOL only for opens/adds (we never swap into the token to copy).
 */
export class DlmmTxBuilder {
  private cache = new Map<string, DLMMInstance>();

  constructor(
    readonly connection: Connection,
    readonly owner: PublicKey,
  ) {}

  async pool(address: string): Promise<DLMMInstance> {
    let d = this.cache.get(address);
    if (!d) {
      d = await DLMM.create(this.connection, new PublicKey(address));
      this.cache.set(address, d);
    } else {
      await d.refetchStates();
    }
    return d;
  }

  async poolInfo(address: string): Promise<PoolInfo> {
    const d = await this.pool(address);
    const mintX = d.lbPair.tokenXMint.toBase58();
    const mintY = d.lbPair.tokenYMint.toBase58();
    return {
      pool: address,
      mintX,
      mintY,
      binStep: d.lbPair.binStep,
      activeBinId: d.lbPair.activeId,
      solIsY: mintY === WSOL_MINT,
    };
  }

  /**
   * Open a position over [lower, upper]. amountSol = 0 opens it empty
   * (Karınca opens first and funds a few seconds later).
   */
  async open(p: {
    pool: string;
    lowerBinId: number;
    upperBinId: number;
    amountSol: bigint;
    strategy: Strategy | null;
    slippagePct: number;
  }): Promise<BuiltTxs> {
    const d = await this.pool(p.pool);
    const kp = Keypair.generate();
    const width = p.upperBinId - p.lowerBinId + 1;
    const extraSigners = new Map<number, Keypair[]>([[0, [kp]]]);

    if (p.amountSol === 0n || width > MAX_BINS_SIMPLE) {
      const create =
        width > MAX_BINS_SIMPLE
          ? await d.createExtendedEmptyPosition(p.lowerBinId, p.upperBinId, kp.publicKey, this.owner)
          : await d.createEmptyPosition({
              positionPubKey: kp.publicKey,
              minBinId: p.lowerBinId,
              maxBinId: p.upperBinId,
              user: this.owner,
            });
      const txs = [create];
      if (p.amountSol > 0n) {
        // The add is built against the on-chain position, so it must be built after the create lands.
        // Callers send `txs[0]`, then call add() for the funding.
      }
      return { txs, extraSigners, position: kp.publicKey.toBase58(), range: { lower: p.lowerBinId, upper: p.upperBinId }, activeId: d.lbPair.activeId };
    }

    const { x, y, range } = this.oneSided(d, p.lowerBinId, p.upperBinId, p.amountSol);
    const tx = await d.initializePositionAndAddLiquidityByStrategy({
      positionPubKey: kp.publicKey,
      user: this.owner,
      totalXAmount: x,
      totalYAmount: y,
      strategy: { minBinId: range[0], maxBinId: range[1], strategyType: toStrategyType(p.strategy) },
      slippage: p.slippagePct,
    });
    return { txs: [tx], extraSigners, position: kp.publicKey.toBase58(), range: { lower: range[0], upper: range[1] }, activeId: d.lbPair.activeId };
  }

  /**
   * The leader's rebalance_liquidity, repeated on our position in ONE transaction:
   * the same removes (bin ranges + bps) and the same add segments (relative to the
   * active bin), already scaled to our size by the caller. The SDK simulates it to
   * build the params (incl. resizing the position) and the instructions (bin
   * arrays to initialize + the rebalance). The sender sets the compute limit.
   */
  async rebalanceOne(p: {
    pool: string;
    position: string;
    removes: Array<{ minBinId: number | null; maxBinId: number | null; bps: number }>;
    adds: Array<{ minDeltaId: number; maxDeltaId: number; x0: bigint; y0: bigint; deltaX: bigint; deltaY: bigint }>;
    favorX: boolean;
    claimFee: boolean;
    maxActiveBinSlippage: number;
    slippagePct: number;
  }): Promise<BuiltTxs & { withdrawn: { x: bigint; y: bigint }; deposited: { x: bigint; y: bigint } }> {
    const d = await this.pool(p.pool);
    const posKey = new PublicKey(p.position);
    const pos = await d.getPosition(posKey);
    const bn = (v: bigint) => new BN(v.toString());
    const sim = await d.simulateRebalancePosition(
      posKey,
      pos.positionData,
      p.claimFee,
      false,
      p.adds.map((a) => ({ minDeltaId: new BN(a.minDeltaId), maxDeltaId: new BN(a.maxDeltaId), x0: bn(a.x0), y0: bn(a.y0), deltaX: bn(a.deltaX), deltaY: bn(a.deltaY), favorXInActiveBin: p.favorX })),
      p.removes.map((r) => ({ minBinId: r.minBinId === null ? null : new BN(r.minBinId), maxBinId: r.maxBinId === null ? null : new BN(r.maxBinId), bps: new BN(r.bps) })),
    );
    const { initBinArrayInstructions, rebalancePositionInstruction } = await d.rebalancePosition(sim, new BN(p.maxActiveBinSlippage), this.owner, p.slippagePct);
    const tx = new Transaction().add(...initBinArrayInstructions, ...rebalancePositionInstruction);
    const r = sim.simulationResult;
    return {
      txs: [tx],
      extraSigners: new Map(),
      position: p.position,
      activeId: d.lbPair.activeId, // the add deltas are relative to THIS bin
      withdrawn: { x: BigInt(r.actualAmountXWithdrawn.toString()), y: BigInt(r.actualAmountYWithdrawn.toString()) },
      deposited: { x: BigInt(r.actualAmountXDeposited.toString()), y: BigInt(r.actualAmountYDeposited.toString()) },
    };
  }

  /** What our position would release for these removes (SDK simulation, nothing sent). */
  async simulateWithdraw(pool: string, position: string, removes: Array<{ minBinId: number | null; maxBinId: number | null; bps: number }>): Promise<{ x: bigint; y: bigint }> {
    const d = await this.pool(pool);
    const posKey = new PublicKey(position);
    const pos = await d.getPosition(posKey);
    const sim = await d.simulateRebalancePosition(
      posKey,
      pos.positionData,
      false,
      false,
      [],
      removes.map((r) => ({ minBinId: r.minBinId === null ? null : new BN(r.minBinId), maxBinId: r.maxBinId === null ? null : new BN(r.maxBinId), bps: new BN(r.bps) })),
    );
    return { x: BigInt(sim.simulationResult.actualAmountXWithdrawn.toString()), y: BigInt(sim.simulationResult.actualAmountYWithdrawn.toString()) };
  }

  /** Add single-sided SOL to an existing position, chunked for wide ranges. */
  async add(p: {
    pool: string;
    position: string;
    lowerBinId: number;
    upperBinId: number;
    amountSol: bigint;
    strategy: Strategy | null;
    slippagePct: number;
  }): Promise<BuiltTxs> {
    const d = await this.pool(p.pool);
    const { x, y, range } = this.oneSided(d, p.lowerBinId, p.upperBinId, p.amountSol);
    const txs = await d.addLiquidityByStrategyChunkable({
      positionPubKey: new PublicKey(p.position),
      user: this.owner,
      totalXAmount: x,
      totalYAmount: y,
      strategy: { minBinId: range[0], maxBinId: range[1], strategyType: toStrategyType(p.strategy) },
      slippage: p.slippagePct,
    });
    return { txs, extraSigners: new Map(), position: p.position };
  }

  /** Remove bps of our position across its whole range; bps 10000 + close also closes it. */
  async remove(p: { pool: string; position: string; bps: number; close: boolean }): Promise<BuiltTxs> {
    const d = await this.pool(p.pool);
    const pos = await d.getPosition(new PublicKey(p.position));
    const hasLiquidity = pos.positionData.positionBinData.some((b) => b.positionLiquidity !== "0");
    if (!hasLiquidity) {
      if (!p.close) return { txs: [], extraSigners: new Map(), position: p.position };
      const tx = await d.closePositionIfEmpty({ owner: this.owner, position: pos });
      return { txs: [tx], extraSigners: new Map(), position: p.position };
    }
    const txs = await d.removeLiquidity({
      user: this.owner,
      position: pos.publicKey,
      fromBinId: pos.positionData.lowerBinId,
      toBinId: pos.positionData.upperBinId,
      bps: new BN(p.bps),
      shouldClaimAndClose: p.close,
    });
    return { txs, extraSigners: new Map(), position: p.position };
  }

  /**
   * Two-sided add over the leader's range (both sides of the price), in the
   * leader's shape: what a zapped copy deposits.
   */
  async addTwoSided(p: {
    pool: string;
    position: string;
    lowerBinId: number;
    upperBinId: number;
    amountSol: bigint;
    amountToken: bigint;
    strategy: Strategy | null;
    slippagePct: number;
  }): Promise<BuiltTxs> {
    const d = await this.pool(p.pool);
    const solIsY = d.lbPair.tokenYMint.toBase58() === WSOL_MINT;
    const [x, y] = solIsY ? [p.amountToken, p.amountSol] : [p.amountSol, p.amountToken];
    const txs = await d.addLiquidityByStrategyChunkable({
      positionPubKey: new PublicKey(p.position),
      user: this.owner,
      totalXAmount: new BN(x.toString()),
      totalYAmount: new BN(y.toString()),
      strategy: { minBinId: p.lowerBinId, maxBinId: p.upperBinId, strategyType: toStrategyType(p.strategy) },
      slippage: p.slippagePct,
    });
    return { txs, extraSigners: new Map(), position: p.position };
  }

  /** Remove bps from a bin sub-range only (flip: the token bins above price). */
  async removeRange(p: { pool: string; position: string; fromBinId: number; toBinId: number; bps: number }): Promise<BuiltTxs> {
    const d = await this.pool(p.pool);
    const txs = await d.removeLiquidity({
      user: this.owner,
      position: new PublicKey(p.position),
      fromBinId: p.fromBinId,
      toBinId: p.toBinId,
      bps: new BN(p.bps),
      shouldClaimAndClose: false,
    });
    return { txs, extraSigners: new Map(), position: p.position };
  }

  /**
   * Add the pool's non-SOL token single-sided ABOVE the price (the "ask" side of a
   * flip). Bins outside the position's range are added by the SDK's auto-expand.
   */
  async addToken(p: {
    pool: string;
    position: string;
    fromBinId: number;
    toBinId: number;
    amount: bigint;
    strategy: Strategy | null;
    slippagePct: number;
  }): Promise<BuiltTxs> {
    const d = await this.pool(p.pool);
    const solIsY = d.lbPair.tokenYMint.toBase58() === WSOL_MINT;
    if (!solIsY) throw new Error("flip supports SOL-as-Y pools only");
    const active = d.lbPair.activeId;
    const from = Math.max(p.fromBinId, active + 1);
    if (p.toBinId < from) throw new Error(`ask range ${p.fromBinId}..${p.toBinId} is not above active ${active}`);
    const txs = await d.addLiquidityByStrategyChunkable({
      positionPubKey: new PublicKey(p.position),
      user: this.owner,
      totalXAmount: new BN(p.amount.toString()),
      totalYAmount: new BN(0),
      strategy: { minBinId: from, maxBinId: p.toBinId, strategyType: toStrategyType(p.strategy), singleSidedX: true },
      slippage: p.slippagePct,
    });
    return { txs, extraSigners: new Map(), position: p.position };
  }

  /** On-chain bins of a position in raw units (x = token, y = SOL for SOL-as-Y pools). */
  async positionBins(pool: string, position: string): Promise<{ bins: Array<{ id: number; x: number; y: number }>; lower: number; upper: number; feeX: bigint; feeY: bigint }> {
    const p = await this.position(pool, position);
    const pd = p.positionData;
    return {
      bins: pd.positionBinData.map((b) => ({ id: b.binId, x: Number(b.positionXAmount), y: Number(b.positionYAmount) })),
      lower: pd.lowerBinId,
      upper: pd.upperBinId,
      feeX: BigInt(pd.feeX.toString()),
      feeY: BigInt(pd.feeY.toString()),
    };
  }

  async claim(p: { pool: string; position: string }): Promise<BuiltTxs> {
    const d = await this.pool(p.pool);
    const pos = await d.getPosition(new PublicKey(p.position));
    const txs = await d.claimSwapFee({ owner: this.owner, position: pos });
    return { txs, extraSigners: new Map(), position: p.position };
  }

  /** All DLMM positions owned by `owner`, across pools. */
  async listPositions(owner: PublicKey = this.owner): Promise<Array<{ pool: string; position: string; lower: number; upper: number }>> {
    const m = await DLMM.getAllLbPairPositionsByUser(this.connection, owner);
    const out: Array<{ pool: string; position: string; lower: number; upper: number }> = [];
    for (const [pool, info] of m) {
      for (const p of info.lbPairPositionsData) {
        out.push({ pool, position: p.publicKey.toBase58(), lower: p.positionData.lowerBinId, upper: p.positionData.upperBinId });
      }
    }
    return out;
  }

  /** Raw balance of a mint held by the owner, across SPL Token and Token-2022 accounts. */
  async tokenBalance(mint: string): Promise<bigint> {
    const res = await this.connection.getParsedTokenAccountsByOwner(this.owner, { mint: new PublicKey(mint) });
    return res.value.reduce((sum, a) => sum + BigInt(a.account.data.parsed.info.tokenAmount.amount as string), 0n);
  }

  /**
   * Swap `amount` of the pool's non-SOL token back to SOL through the same pool.
   * Fallback route when Jupiter has none; slippage comes from the user's setting.
   */
  async swapTokenToSol(p: {
    pool: string;
    amount: bigint;
    slippageBps: number;
  }): Promise<{ built: BuiltTxs; outLamports: bigint; minOutLamports: bigint; impactBps: number } | null> {
    if (p.amount <= 0n) return null;
    const d = await this.pool(p.pool);
    const solIsY = d.lbPair.tokenYMint.toBase58() === WSOL_MINT;
    const swapForY = solIsY; // token X → SOL(Y), or token Y → SOL(X)
    const inToken = solIsY ? d.lbPair.tokenXMint : d.lbPair.tokenYMint;
    const outToken = solIsY ? d.lbPair.tokenYMint : d.lbPair.tokenXMint;
    const binArrays = await d.getBinArrayForSwap(swapForY, 10);
    const quote = d.swapQuote(new BN(p.amount.toString()), swapForY, new BN(p.slippageBps), binArrays, true);
    const tx = await d.swap({
      inToken,
      outToken,
      inAmount: quote.consumedInAmount,
      minOutAmount: quote.minOutAmount,
      lbPair: d.pubkey,
      user: this.owner,
      binArraysPubkey: quote.binArraysPubkey,
    });
    return {
      built: { txs: [tx], extraSigners: new Map(), position: null },
      outLamports: BigInt(quote.outAmount.toString()),
      minOutLamports: BigInt(quote.minOutAmount.toString()),
      impactBps: Math.round(Number(quote.priceImpact.toString()) * 100),
    };
  }

  async position(pool: string, position: string): Promise<LbPosition> {
    return (await this.pool(pool)).getPosition(new PublicKey(position));
  }

  /**
   * SOL can only sit at or below the active bin when SOL is Y (above it when SOL is X).
   * Clamp the range to that side so a single-sided deposit is valid.
   */
  private oneSided(d: DLMMInstance, lower: number, upper: number, amountSol: bigint) {
    const active = d.lbPair.activeId;
    const solIsY = d.lbPair.tokenYMint.toBase58() === WSOL_MINT;
    const solIsX = d.lbPair.tokenXMint.toBase58() === WSOL_MINT;
    if (!solIsX && !solIsY) throw new Error("pool has no SOL side");
    const range: [number, number] = solIsY ? [lower, Math.min(upper, active)] : [Math.max(lower, active), upper];
    if (range[0] > range[1]) throw new Error(`no bins on the SOL side (active ${active}, range ${lower}..${upper})`);
    const amt = new BN(amountSol.toString());
    return { x: solIsY ? new BN(0) : amt, y: solIsY ? amt : new BN(0), range };
  }
}

function toStrategyType(s: Strategy | null): number {
  return s && s !== "custom" ? STRATEGY_TYPE[s] : STRATEGY_TYPE.spot;
}
