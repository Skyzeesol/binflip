import { createRequire } from "node:module";
import type { LiquidityRead } from "./dammRemove.js";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { WSOL_MINT } from "../constants.js";
import type { BuiltTxs } from "./dlmmTx.js";

// Load the CJS build, like the DLMM SDK (consistent module resolution under Node).
const require = createRequire(import.meta.url);
type CpAmmModule = typeof import("@meteora-ag/cp-amm-sdk");
const cp = require("@meteora-ag/cp-amm-sdk") as CpAmmModule;
type PoolState = Awaited<ReturnType<InstanceType<CpAmmModule["CpAmm"]>["fetchPoolState"]>>;
type PositionState = Awaited<ReturnType<InstanceType<CpAmmModule["CpAmm"]>["fetchPositionState"]>>;

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const Q64 = 2 ** 64;

export interface DammPoolInfo {
  pool: string;
  mintA: string;
  mintB: string;
  solIsA: boolean;
  solIsB: boolean;
  /** Lamports per raw unit of the non-SOL token. */
  tokenPriceLamports: number | null;
}

/**
 * Meteora DAMM V2 (cp-amm) transactions for our agent wallet, via the official
 * SDK. DAMM V2 positions take both tokens at the pool price, so a copy is
 * always a "zap": the caller buys the token share first, then adds both.
 */
export class DammTxBuilder {
  readonly cpAmm: InstanceType<CpAmmModule["CpAmm"]>;

  constructor(
    readonly connection: Connection,
    readonly owner: PublicKey,
  ) {
    this.cpAmm = new cp.CpAmm(connection);
  }

  async poolState(pool: string): Promise<PoolState> {
    return this.cpAmm.fetchPoolState(new PublicKey(pool));
  }

  async poolInfo(pool: string): Promise<DammPoolInfo> {
    const s = await this.poolState(pool);
    const mintA = s.tokenAMint.toBase58();
    const mintB = s.tokenBMint.toBase58();
    const priceBperA = (Number(s.sqrtPrice.toString()) / Q64) ** 2; // raw B per raw A
    const solIsA = mintA === WSOL_MINT;
    const solIsB = mintB === WSOL_MINT;
    return {
      pool,
      mintA,
      mintB,
      solIsA,
      solIsB,
      tokenPriceLamports: solIsB ? priceBperA : solIsA ? (priceBperA > 0 ? 1 / priceBperA : null) : null,
    };
  }

  private programs(s: PoolState) {
    return { tokenAProgram: s.tokenAFlag === 1 ? TOKEN_2022 : TOKEN_PROGRAM, tokenBProgram: s.tokenBFlag === 1 ? TOKEN_2022 : TOKEN_PROGRAM };
  }

  private liquidityFor(s: PoolState, amountA: bigint, amountB: bigint): BN {
    return this.cpAmm.getLiquidityDelta({
      maxAmountTokenA: new BN(amountA.toString()),
      maxAmountTokenB: new BN(amountB.toString()),
      sqrtPrice: s.sqrtPrice,
      sqrtMinPrice: s.sqrtMinPrice,
      sqrtMaxPrice: s.sqrtMaxPrice,
      collectFeeMode: s.collectFeeMode,
      tokenAAmount: s.tokenAAmount,
      tokenBAmount: s.tokenBAmount,
    } as never);
  }

  /** Open a new position with both tokens. Amounts are what we hold after the zap. */
  async open(p: { pool: string; amountA: bigint; amountB: bigint; slippageBps: number }): Promise<BuiltTxs> {
    const s = await this.poolState(p.pool);
    const nft = Keypair.generate();
    const liquidityDelta = this.liquidityFor(s, p.amountA, p.amountB);
    const tx = await this.cpAmm.createPositionAndAddLiquidity({
      owner: this.owner,
      pool: new PublicKey(p.pool),
      positionNft: nft.publicKey,
      liquidityDelta,
      maxAmountTokenA: new BN(p.amountA.toString()),
      maxAmountTokenB: new BN(p.amountB.toString()),
      tokenAAmountThreshold: new BN(p.amountA.toString()),
      tokenBAmountThreshold: new BN(p.amountB.toString()),
      tokenAMint: s.tokenAMint,
      tokenBMint: s.tokenBMint,
      ...this.programs(s),
    });
    const position = cp.derivePositionAddress(nft.publicKey).toBase58();
    return { txs: [tx], extraSigners: new Map([[0, [nft]]]), position };
  }

  async add(p: { pool: string; position: string; amountA: bigint; amountB: bigint }): Promise<BuiltTxs> {
    const s = await this.poolState(p.pool);
    const pos = await this.cpAmm.fetchPositionState(new PublicKey(p.position));
    const tx = await this.cpAmm.addLiquidity({
      owner: this.owner,
      position: new PublicKey(p.position),
      pool: new PublicKey(p.pool),
      positionNftAccount: cp.derivePositionNftAccount(pos.nftMint),
      liquidityDelta: this.liquidityFor(s, p.amountA, p.amountB),
      maxAmountTokenA: new BN(p.amountA.toString()),
      maxAmountTokenB: new BN(p.amountB.toString()),
      tokenAAmountThreshold: new BN(p.amountA.toString()),
      tokenBAmountThreshold: new BN(p.amountB.toString()),
      tokenAMint: s.tokenAMint,
      tokenBMint: s.tokenBMint,
      tokenAVault: s.tokenAVault,
      tokenBVault: s.tokenBVault,
      ...this.programs(s),
    });
    return { txs: [tx], extraSigners: new Map(), position: p.position };
  }

  /** Remove `bps` of our unlocked liquidity; 10000 + close removes everything and closes the position. */
  async remove(p: { pool: string; position: string; bps: number; close: boolean }): Promise<BuiltTxs> {
    const s = await this.poolState(p.pool);
    const pk = new PublicKey(p.position);
    const pos = await this.cpAmm.fetchPositionState(pk);
    const nftAccount = cp.derivePositionNftAccount(pos.nftMint);
    if (p.close && p.bps >= 10_000) {
      const currentPoint = await cp.getCurrentPoint(this.connection, s.activationType);
      const tx = await this.cpAmm.removeAllLiquidityAndClosePosition({
        owner: this.owner,
        position: pk,
        positionNftAccount: nftAccount,
        poolState: s,
        positionState: pos,
        tokenAAmountThreshold: new BN(0),
        tokenBAmountThreshold: new BN(0),
        vestings: [],
        currentPoint,
      });
      return { txs: [tx], extraSigners: new Map(), position: p.position };
    }
    const liquidityDelta = pos.unlockedLiquidity.mul(new BN(p.bps)).div(new BN(10_000));
    if (liquidityDelta.isZero()) return { txs: [], extraSigners: new Map(), position: p.position };
    const tx = await this.cpAmm.removeLiquidity({
      owner: this.owner,
      position: pk,
      pool: new PublicKey(p.pool),
      positionNftAccount: nftAccount,
      liquidityDelta,
      tokenAAmountThreshold: new BN(0),
      tokenBAmountThreshold: new BN(0),
      tokenAMint: s.tokenAMint,
      tokenBMint: s.tokenBMint,
      tokenAVault: s.tokenAVault,
      tokenBVault: s.tokenBVault,
      ...this.programs(s),
      vestings: [],
      currentPoint: await cp.getCurrentPoint(this.connection, s.activationType),
    } as never);
    return { txs: [tx], extraSigners: new Map(), position: p.position };
  }

  async claim(p: { pool: string; position: string }): Promise<BuiltTxs> {
    const s = await this.poolState(p.pool);
    const pos = await this.cpAmm.fetchPositionState(new PublicKey(p.position));
    const tx = await this.cpAmm.claimPositionFee({
      owner: this.owner,
      position: new PublicKey(p.position),
      pool: new PublicKey(p.pool),
      positionNftAccount: cp.derivePositionNftAccount(pos.nftMint),
      tokenAMint: s.tokenAMint,
      tokenBMint: s.tokenBMint,
      tokenAVault: s.tokenAVault,
      tokenBVault: s.tokenBVault,
      ...this.programs(s),
    });
    return { txs: [tx], extraSigners: new Map(), position: p.position };
  }

  /** Unlocked liquidity of any position (used to turn a leader's remove into a share). */
  /** The position's unlocked liquidity, telling "account gone" apart from a failed read (never guess 0). */
  async positionLiquidity(position: string): Promise<LiquidityRead> {
    try {
      const info = await this.connection.getAccountInfo(new PublicKey(position), "confirmed");
      if (!info) return { status: "missing" };
      const pos = await this.cpAmm.fetchPositionState(new PublicKey(position));
      return { status: "ok", liquidity: BigInt(pos.unlockedLiquidity.toString()) };
    } catch (err) {
      return { status: "error", message: (err as Error).message };
    }
  }

  async unlockedLiquidity(position: string): Promise<bigint> {
    const pos = await this.cpAmm.fetchPositionState(new PublicKey(position));
    return BigInt(pos.unlockedLiquidity.toString());
  }

  /** Position value in lamports at the pool price, incl. pending fees (for TP/SL). */
  async positionValue(pool: string, position: string): Promise<number> {
    const s = await this.poolState(pool);
    const pos: PositionState = await this.cpAmm.fetchPositionState(new PublicKey(position));
    const q = this.cpAmm.getWithdrawQuote({ liquidityDelta: pos.unlockedLiquidity, minSqrtPrice: s.sqrtMinPrice, maxSqrtPrice: s.sqrtMaxPrice, sqrtPrice: s.sqrtPrice, collectFeeMode: s.collectFeeMode } as never);
    const a = Number(q.outAmountA.toString()) + Number(pos.feeAPending?.toString() ?? 0);
    const b = Number(q.outAmountB.toString()) + Number(pos.feeBPending?.toString() ?? 0);
    const priceBperA = (Number(s.sqrtPrice.toString()) / Q64) ** 2;
    const solIsB = s.tokenBMint.toBase58() === WSOL_MINT;
    return solIsB ? b + a * priceBperA : a + (priceBperA > 0 ? b / priceBperA : 0);
  }
}

