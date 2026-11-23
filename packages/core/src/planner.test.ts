import { describe, expect, it } from "vitest";
import { WSOL_MINT } from "./constants.js";
import type { LeaderAction } from "./meteora/actions.js";
import { planCopy, type OurPosition, type PlannerSettings } from "./planner.js";

const SOL = 1_000_000_000n;
const TOKEN = "TokenMint1111111111111111111111111111111111";

const action = (o: Partial<LeaderAction>): LeaderAction => ({
  protocol: "dlmm",
  kind: "add",
  position: "Pos1",
  pool: "Pool1",
  owner: "Leader1",
  ixIndex: 0,
  instructions: [],
  created: false,
  closed: false,
  mintX: TOKEN,
  mintY: WSOL_MINT,
  added: { x: 0n, y: 0n },
  removed: { x: 0n, y: 0n },
  fees: { x: 0n, y: 0n },
  strategy: "bid_ask",
  lowerBinId: null,
  upperBinId: null,
  activeBinId: null,
  removeRanges: [],
  rebalance: null,
  ...o,
});

const settings = (o: Partial<PlannerSettings> = {}): PlannerSettings => ({
  sizing: { mode: "percent_of_leader", percentBps: 5000, fixedSol: null, maxPerAdd: null, maxPerPosition: null },
  copyDlmmStrategies: ["spot", "curve", "bid_ask", "custom"],
  copyDammV2: true,
  memeProtection: true,
  leaderPaused: false,
  followExitsWhilePaused: false,
  killSwitch: false,
  fundProtectionTripped: false,
  maxSolPerTx: 100n * SOL,
  dailyRoom: 100n * SOL,
  ...o,
});

const ours = (o: Partial<OurPosition> = {}): OurPosition => ({
  id: "our1",
  state: "OPENING",
  depositedSol: 0n,
  ratioPpm: null,
  fundedAt: null,
  lowerBinId: -599,
  upperBinId: -512,
  ...o,
});

describe("planCopy", () => {
  it("Karınca pattern: empty open, then the funding add is sized as first funding", () => {
    expect(planCopy(action({ kind: "open", created: true, added: { x: 0n, y: 0n } }), settings(), null)).toMatchObject({
      do: "open",
      empty: true,
    });
    const p = planCopy(action({ kind: "add", added: { x: 0n, y: 218_335_023n } }), settings(), ours());
    expect(p).toMatchObject({ do: "add", amountSol: 109_167_511n, firstFunding: true });
  });

  it("adds to positions we never copied are skipped", () => {
    expect(planCopy(action({ added: { x: 0n, y: SOL } }), settings(), null)).toMatchObject({
      do: "skip",
      reason: "position_not_copied",
    });
  });

  it("meme protection: token-only add is skipped", () => {
    expect(planCopy(action({ added: { x: 5n * SOL, y: 0n } }), settings(), ours())).toMatchObject({
      reason: "meme_protection",
    });
  });

  it("unticked strategy is skipped", () => {
    const s = settings({ copyDlmmStrategies: ["spot"] });
    expect(planCopy(action({ kind: "open", created: true, added: { x: 0n, y: SOL } }), s, null)).toMatchObject({
      reason: "strategy_not_copied",
    });
  });

  it("paused leader (LP Agent): nothing is copied, closes included; following exits is opt-in", () => {
    const s = settings({ leaderPaused: true });
    expect(planCopy(action({ kind: "open", created: true }), s, null)).toMatchObject({ reason: "leader_paused" });
    expect(planCopy(action({ kind: "close", closed: true }), s, ours({ state: "ACTIVE" }))).toMatchObject({ reason: "leader_paused" });
    expect(planCopy(action({ kind: "close", closed: true }), { ...s, followExitsWhilePaused: true }, ours({ state: "ACTIVE" }))).toEqual({ do: "close" });
  });

  it("kill switch and fund protection block entries, not exits", () => {
    for (const s of [settings({ killSwitch: true }), settings({ fundProtectionTripped: true })]) {
      expect(planCopy(action({ added: { x: 0n, y: SOL } }), s, ours())).toMatchObject({ do: "skip" });
      expect(planCopy(action({ kind: "close", closed: true }), s, ours({ state: "ACTIVE" }))).toEqual({ do: "close" });
    }
  });

  it("full range removal mirrors 100%", () => {
    const a = action({ kind: "remove", removeRanges: [{ minBinId: -599, maxBinId: -512, bps: 10_000 }] });
    expect(planCopy(a, settings(), ours({ state: "ACTIVE" }))).toEqual({ do: "remove", bps: 10_000 });
  });

  it("per-tx safety cap and daily limit", () => {
    const capped = planCopy(action({ added: { x: 0n, y: 10n * SOL } }), settings({ maxSolPerTx: SOL }), ours());
    expect(capped).toMatchObject({ do: "add", amountSol: SOL, capped: "max_sol_per_tx" });
    const daily = planCopy(action({ added: { x: 0n, y: 10n * SOL } }), settings({ dailyRoom: SOL }), ours());
    expect(daily).toMatchObject({ reason: "daily_limit" });
  });

  it("safety cap on first funding locks the smaller share (live Karınca case: 3.579 SOL, cap 1)", () => {
    const first = planCopy(action({ added: { x: 0n, y: 3_579_100_000n } }), settings({ maxSolPerTx: SOL }), ours());
    expect(first).toMatchObject({ do: "add", amountSol: SOL, firstFunding: true });
    if (first.do !== "add") throw new Error();
    expect(first.ratioPpm).toBe(279_399n);
    const next = planCopy(
      action({ added: { x: 0n, y: 1_158_900_000n } }),
      settings({ maxSolPerTx: SOL }),
      ours({ depositedSol: SOL, ratioPpm: first.ratioPpm, fundedAt: new Date() }),
    );
    expect(next).toMatchObject({ do: "add", amountSol: 323_795_501n, firstFunding: false });
  });

  it("rebalance: full move is mirrored, partial / top-up are skipped", () => {
    const rebalance = {
      oldMin: -599,
      oldMax: -512,
      newMin: -620,
      newMax: -533,
      adds: [{ min_delta_id: -87, max_delta_id: 0, x0: 0n, y0: 10n, delta_x: 0n, delta_y: 1n, bit_flag: 0 }],
      favorX: false,
    };
    const full = action({ kind: "rebalance", added: { x: 0n, y: SOL }, removed: { x: 0n, y: SOL }, removeRanges: [{ minBinId: -599, maxBinId: -512, bps: 10_000 }], rebalance });
    expect(planCopy(full, settings(), ours({ state: "ACTIVE" }))).toEqual({ do: "rebalance" });
    expect(planCopy({ ...full, removeRanges: [{ minBinId: -599, maxBinId: -512, bps: 3_000 }] }, settings(), ours({ state: "ACTIVE" }))).toMatchObject({ reason: "rebalance_partial" });
    expect(planCopy({ ...full, added: { x: 0n, y: 2n * SOL } }, settings(), ours({ state: "ACTIVE" }))).toMatchObject({ reason: "rebalance_topup" });
    expect(planCopy(full, settings(), null)).toMatchObject({ reason: "position_not_copied" });
  });

  it("meme protection is value-based (>95% of the deposit in the token) when the price is known", () => {
    // price 1 lamport per raw token: 0.5 SOL + 9.5 SOL worth of token = 95% → still allowed; 96% → skipped
    const at95 = action({ added: { x: 9_500_000_000n, y: 500_000_000n } });
    expect(planCopy(at95, settings({ tokenPriceLamports: 1 }), ours())).toMatchObject({ do: "add" });
    const at96 = action({ added: { x: 9_600_000_000n, y: 400_000_000n } });
    expect(planCopy(at96, settings({ tokenPriceLamports: 1 }), ours())).toMatchObject({ reason: "meme_protection" });
  });

  it("two-sided leader add: sized on total value and zapped in the leader's ratio", () => {
    // leader: 1 SOL + token worth 1 SOL; 50% copy → 1 SOL total, half swapped into the token
    const two = action({ added: { x: 2_000_000_000n, y: SOL } });
    const p = planCopy(two, settings({ tokenPriceLamports: 0.5 }), ours());
    expect(p).toMatchObject({ do: "add", amountSol: SOL, swapSol: SOL / 2n, firstFunding: true });
  });

  it("SOL-only leader adds never swap", () => {
    expect(planCopy(action({ added: { x: 0n, y: SOL } }), settings({ tokenPriceLamports: 2 }), ours())).not.toHaveProperty("swapSol");
  });

  it("DAMM V2 respects the pool-type toggle", () => {
    const a = action({ protocol: "damm_v2", kind: "open", created: true, added: { x: 0n, y: SOL } });
    expect(planCopy(a, settings({ copyDammV2: false }), null)).toMatchObject({ reason: "pool_type_not_copied" });
  });
});
