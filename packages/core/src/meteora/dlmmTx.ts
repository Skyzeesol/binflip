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
      return { txs, extraSigners, position: kp.publicKey.toBase58() };
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
    return { txs: [tx], extraSigners, position: kp.publicKey.toBase58() };
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

  async claim(p: { pool: string; position: string }): Promise<BuiltTxs> {
    const d = await this.pool(p.pool);
    const pos = await d.getPosition(new PublicKey(p.position));
    const txs = await d.claimSwapFee({ owner: this.owner, position: pos });
    return { txs, extraSigners: new Map(), position: p.position };
  }

  /** Raw balance of a mint held by the owner, across SPL Token and Token-2022 accounts. */
  async tokenBalance(mint: string): Promise<bigint> {
    const res = await this.connection.getParsedTokenAccountsByOwner(this.owner, { mint: new PublicKey(mint) });
    return res.value.reduce((sum, a) => sum + BigInt(a.account.data.parsed.info.tokenAmount.amount as string), 0n);
  }

  /**
   * Swap `amount` of the pool's non-SOL token back to SOL through the same pool.
   * Returns null (no tx) when the quote's price impact exceeds maxImpactBps, so
   * a thin pool never dumps the token for nothing; the caller leaves it in the wallet.
   */
  async swapTokenToSol(p: {
    pool: string;
    amount: bigint;
    slippageBps: number;
    maxImpactBps: number;
  }): Promise<{ built: BuiltTxs; outLamports: bigint; minOutLamports: bigint; impactBps: number } | { skipped: "price_impact"; impactBps: number } | null> {
    if (p.amount <= 0n) return null;
    const d = await this.pool(p.pool);
    const solIsY = d.lbPair.tokenYMint.toBase58() === WSOL_MINT;
    const swapForY = solIsY; // token X → SOL(Y), or token Y → SOL(X)
    const inToken = solIsY ? d.lbPair.tokenXMint : d.lbPair.tokenYMint;
    const outToken = solIsY ? d.lbPair.tokenYMint : d.lbPair.tokenXMint;
    const binArrays = await d.getBinArrayForSwap(swapForY, 10);
    const quote = d.swapQuote(new BN(p.amount.toString()), swapForY, new BN(p.slippageBps), binArrays, true);
    const impactBps = Math.round(Number(quote.priceImpact.toString()) * 100);
    if (impactBps > p.maxImpactBps) return { skipped: "price_impact", impactBps };
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
      impactBps,
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
