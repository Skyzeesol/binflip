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
  ...o,
});

const settings = (o: Partial<PlannerSettings> = {}): PlannerSettings => ({
  sizing: { mode: "percent_of_leader", percentBps: 5000, fixedSol: null, maxPerAdd: null, maxPerPosition: null },
  copyDlmmStrategies: ["spot", "curve", "bid_ask", "custom"],
  copyDammV2: true,
  memeProtection: true,
  leaderPaused: false,
  followExitsWhilePaused: true,
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

  it("paused leader: opens skipped, closes still followed by default", () => {
    const s = settings({ leaderPaused: true });
    expect(planCopy(action({ kind: "open", created: true }), s, null)).toMatchObject({ reason: "leader_paused" });
    expect(planCopy(action({ kind: "close", closed: true }), s, ours({ state: "ACTIVE" }))).toEqual({ do: "close" });
    expect(
      planCopy(action({ kind: "close", closed: true }), { ...s, followExitsWhilePaused: false }, ours()),
    ).toMatchObject({ reason: "leader_paused" });
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

  it("DAMM V2 respects the pool-type toggle", () => {
    const a = action({ protocol: "damm_v2", kind: "open", created: true, added: { x: 0n, y: SOL } });
    expect(planCopy(a, settings({ copyDammV2: false }), null)).toMatchObject({ reason: "pool_type_not_copied" });
  });
});
