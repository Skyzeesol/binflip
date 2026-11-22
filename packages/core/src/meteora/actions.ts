import type { Decoded, DecodedEvent, DecodedIx, Protocol } from "./decode.js";
import { classifyRebalanceAdds, strategyFromType, type RebalanceAdd, type Strategy } from "./strategy.js";

export type ActionKind = "open" | "add" | "remove" | "close" | "claim" | "rebalance";

export interface Pair {
  x: bigint;
  y: bigint;
}

export interface RemoveRange {
  minBinId: number | null;
  maxBinId: number | null;
  bps: number;
}

/** One leader move on one position, as the executor needs it. */
export interface LeaderAction {
  protocol: Protocol;
  kind: ActionKind;
  position: string;
  pool: string | null;
  owner: string | null;
  /** Lowest top-level instruction index touching this position; part of the idempotency key. */
  ixIndex: number;
  instructions: string[];
  created: boolean;
  closed: boolean;
  mintX: string | null;
  mintY: string | null;
  added: Pair;
  removed: Pair;
  fees: Pair;
  strategy: Strategy | null;
  /** Range after this move, when the transaction tells us. */
  lowerBinId: number | null;
  upperBinId: number | null;
  activeBinId: number | null;
  /** Range-based removals (DLMM). Executor maps these onto our own position. */
  removeRanges: RemoveRange[];
  /** Full detail of a rebalance_liquidity move, so we can repeat it scaled to our size. */
  rebalance: RebalanceDetail | null;
}

export interface RebalanceDetail {
  oldMin: number;
  oldMax: number;
  newMin: number;
  newMax: number;
  /** The leader's add segments, relative to the active bin (signed via bit_flag). */
  adds: RebalanceAdd[];
  favorX: boolean;
}

const ZERO: Pair = { x: 0n, y: 0n };

/**
 * Group decoded instructions/events by position and classify each group.
 * Positions with no economic effect (e.g. only a resize) are dropped.
 */
export function extractActions(decoded: Decoded[]): LeaderAction[] {
  const byPosition = new Map<string, Builder>();
  const get = (protocol: Protocol, position: string, topIndex: number) => {
    let b = byPosition.get(position);
    if (!b) {
      b = new Builder(protocol, position, topIndex);
      byPosition.set(position, b);
    }
    b.ixIndex = Math.min(b.ixIndex, topIndex);
    return b;
  };

  for (const d of decoded) {
    const position = positionOf(d);
    if (!position) continue;
    const b = get(d.protocol, position, d.topIndex);
    if (d.kind === "ix") b.onIx(d);
    else b.onEvent(d);
  }
  return [...byPosition.values()].map((b) => b.build()).filter((a): a is LeaderAction => a !== null);
}

function positionOf(d: Decoded): string | null {
  if (d.kind === "ix") return d.accounts.position ?? null;
  const p = d.data.position;
  return typeof p === "string" ? p : null;
}

class Builder {
  instructions: string[] = [];
  created = false;
  closed = false;
  pool: string | null = null;
  owner: string | null = null;
  mintX: string | null = null;
  mintY: string | null = null;
  added: Pair = { ...ZERO };
  removed: Pair = { ...ZERO };
  fees: Pair = { ...ZERO };
  strategy: Strategy | null = null;
  lower: number | null = null;
  upper: number | null = null;
  active: number | null = null;
  removeRanges: RemoveRange[] = [];
  rebalanced = false;
  dammRemove = false;
  rebalanceAdds: RebalanceAdd[] = [];
  favorX = false;
  oldRange: [number, number] | null = null;

  constructor(
    readonly protocol: Protocol,
    readonly position: string,
    public ixIndex: number,
  ) {}

  onIx(ix: DecodedIx) {
    this.instructions.push(ix.name);
    const a = ix.accounts;
    this.pool ??= a.lb_pair ?? a.pool ?? null;
    this.owner ??= a.owner ?? a.sender ?? a.signer ?? null;
    this.mintX ??= a.token_x_mint ?? a.token_a_mint ?? a.token_mint ?? null;
    this.mintY ??= a.token_y_mint ?? a.token_b_mint ?? null;
    const args = ix.args;

    switch (ix.name) {
      case "initialize_position":
      case "initialize_position2":
      case "initialize_position_pda":
      case "initialize_position_by_operator": {
        const lower = Number(args.lower_bin_id);
        const width = Number(args.width);
        this.lower = lower;
        this.upper = lower + width - 1;
        break;
      }
      case "add_liquidity_by_strategy":
      case "add_liquidity_by_strategy2":
      case "add_liquidity_by_strategy_one_side": {
        const lp = args.liquidity_parameter as { strategy_parameters?: { strategy_type?: unknown } };
        this.strategy = strategyFromType(lp?.strategy_parameters?.strategy_type) ?? this.strategy;
        break;
      }
      case "add_liquidity":
      case "add_liquidity2":
      case "add_liquidity_by_weight":
      case "add_liquidity_by_weight2":
      case "add_liquidity_one_side":
      case "add_liquidity_one_side_precise":
      case "add_liquidity_one_side_precise2":
        if (this.protocol === "dlmm") this.strategy ??= "custom";
        break;
      case "remove_liquidity_by_range":
      case "remove_liquidity_by_range2":
        this.removeRanges.push({
          minBinId: Number(args.from_bin_id),
          maxBinId: Number(args.to_bin_id),
          bps: Number(args.bps_to_remove),
        });
        break;
      case "remove_all_liquidity":
        if (this.protocol === "dlmm") this.removeRanges.push({ minBinId: null, maxBinId: null, bps: 10_000 });
        else this.dammRemove = true;
        break;
      case "remove_liquidity":
        if (this.protocol === "damm_v2") this.dammRemove = true;
        break;
      case "rebalance_liquidity": {
        const p = args.params as {
          removes?: Array<{ min_bin_id: number | null; max_bin_id: number | null; bps: number }>;
          adds?: Parameters<typeof classifyRebalanceAdds>[0];
        };
        for (const r of p?.removes ?? []) {
          this.removeRanges.push({ minBinId: r.min_bin_id, maxBinId: r.max_bin_id, bps: Number(r.bps) });
        }
        if (p?.adds?.length) {
          this.strategy = classifyRebalanceAdds(p.adds);
          this.rebalanceAdds.push(...p.adds);
          this.favorX ||= p.adds.some((x) => Boolean((x as { favor_x_in_active_id?: boolean }).favor_x_in_active_id));
        }
        break;
      }
    }
  }

  onEvent(ev: DecodedEvent) {
    const d = ev.data as Record<string, any>;
    this.pool ??= d.lb_pair ?? d.pool ?? null;
    this.owner ??= d.owner ?? d.from ?? null;
    if (d.active_bin_id !== undefined) this.active = Number(d.active_bin_id);

    switch (ev.name) {
      case "PositionCreate":
      case "EvtCreatePosition":
        this.created = true;
        break;
      case "PositionClose":
      case "EvtClosePosition":
        this.closed = true;
        break;
      case "AddLiquidity":
        this.added.x += d.amounts[0];
        this.added.y += d.amounts[1];
        break;
      case "RemoveLiquidity":
        this.removed.x += d.amounts[0];
        this.removed.y += d.amounts[1];
        break;
      case "Rebalancing":
        this.rebalanced = true;
        this.added.x += d.x_added_amount;
        this.added.y += d.y_added_amount;
        this.removed.x += d.x_withdrawn_amount;
        this.removed.y += d.y_withdrawn_amount;
        this.fees.x += d.x_fee_amount;
        this.fees.y += d.y_fee_amount;
        this.oldRange ??= [Number(d.old_min_id), Number(d.old_max_id)];
        this.lower = Number(d.new_min_id);
        this.upper = Number(d.new_max_id);
        break;
      case "ClaimFee":
      case "ClaimFee2":
        this.fees.x += d.fee_x;
        this.fees.y += d.fee_y;
        break;
      case "EvtClaimPositionFee":
        this.fees.x += d.fee_a_claimed;
        this.fees.y += d.fee_b_claimed;
        break;
      case "EvtLiquidityChange": {
        // Direction comes from the instruction (add vs remove) seen in the same tx.
        const pair = { x: d.token_a_amount as bigint, y: d.token_b_amount as bigint };
        this.pendingDamm.push(pair);
        break;
      }
      case "IncreasePositionLength":
        // side 0 = lower, 1 = upper (ResizeSide in the SDK)
        if (this.lower !== null && this.upper !== null) {
          if (Number(d.side) === 0) this.lower -= Number(d.length_to_add);
          else this.upper += Number(d.length_to_add);
        }
        break;
    }
  }

  pendingDamm: Pair[] = [];

  build(): LeaderAction | null {
    for (const p of this.pendingDamm) {
      const target = this.dammRemove ? this.removed : this.added;
      target.x += p.x;
      target.y += p.y;
    }
    const hasAdd = this.added.x > 0n || this.added.y > 0n;
    const hasRemove = this.removed.x > 0n || this.removed.y > 0n || this.removeRanges.length > 0;
    const hasFees = this.fees.x > 0n || this.fees.y > 0n;

    let kind: ActionKind;
    if (this.closed) kind = "close";
    else if (this.created) kind = "open";
    else if (this.rebalanced && hasAdd && hasRemove) kind = "rebalance";
    else if (hasAdd) kind = "add";
    else if (hasRemove) kind = "remove";
    else if (hasFees) kind = "claim";
    else return null; // resize-only or nothing we act on

    return {
      protocol: this.protocol,
      kind,
      position: this.position,
      pool: this.pool,
      owner: this.owner,
      ixIndex: this.ixIndex,
      instructions: this.instructions,
      created: this.created,
      closed: this.closed,
      mintX: this.mintX,
      mintY: this.mintY,
      added: this.added,
      removed: this.removed,
      fees: this.fees,
      strategy: this.strategy,
      lowerBinId: this.lower,
      upperBinId: this.upper,
      activeBinId: this.active,
      removeRanges: this.removeRanges,
      rebalance:
        this.rebalanced && this.oldRange && this.lower !== null && this.upper !== null
          ? { oldMin: this.oldRange[0], oldMax: this.oldRange[1], newMin: this.lower, newMax: this.upper, adds: this.rebalanceAdds, favorX: this.favorX }
          : null,
    };
  }
}
