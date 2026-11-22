import { describe, expect, it } from "vitest";
import { sizeDeposit, suggestedPercentBps, type PositionSizingState, type SizingSettings } from "./sizing.js";

const SOL = 1_000_000_000n;
const fresh: PositionSizingState = { ratioPpm: null, depositedSol: 0n, fundedAt: null };
const pct = (bps: number, max: bigint | null = null): SizingSettings => ({
  mode: "percent_of_leader",
  percentBps: bps,
  fixedSol: null,
  maxPerAdd: max,
  maxPerPosition: null,
});

describe("sizeDeposit (LP Agent examples)", () => {
  it("80%, max 8 SOL: open 1 → 0.8, add 29 → capped at 8", () => {
    const s = pct(8000, 8n * SOL);
    const open = sizeDeposit(1n * SOL, s, fresh);
    expect(open).toMatchObject({ ok: true, amount: 800_000_000n, capped: null });
    if (!open.ok) throw new Error();
    const add = sizeDeposit(29n * SOL, s, {
      ratioPpm: open.ratioPpm,
      depositedSol: open.amount,
      fundedAt: new Date(),
    });
    expect(add).toMatchObject({ ok: true, amount: 8n * SOL, capped: "max_per_add" });
  });

  it("50%, max 7 SOL: open 100 → 7 (7%), later add 10 → 0.7 at the locked share", () => {
    const s = pct(5000, 7n * SOL);
    const open = sizeDeposit(100n * SOL, s, fresh);
    expect(open).toMatchObject({ ok: true, amount: 7n * SOL, ratioPpm: 70_000n });
    if (!open.ok) throw new Error();
    const add = sizeDeposit(10n * SOL, s, { ratioPpm: open.ratioPpm, depositedSol: open.amount, fundedAt: new Date() });
    expect(add).toMatchObject({ ok: true, amount: 700_000_000n });
  });

  it("locked share expires after 30 days", () => {
    const s = pct(5000, 7n * SOL);
    const old = new Date(Date.now() - 31 * 86_400_000);
    const add = sizeDeposit(10n * SOL, s, { ratioPpm: 70_000n, depositedSol: 7n * SOL, fundedAt: old });
    expect(add).toMatchObject({ ok: true, amount: 5n * SOL });
  });

  it("only a max: match the leader up to the max", () => {
    const s: SizingSettings = { ...pct(0), percentBps: null, maxPerAdd: 2n * SOL };
    expect(sizeDeposit(1n * SOL, s, fresh)).toMatchObject({ ok: true, amount: 1n * SOL });
    expect(sizeDeposit(5n * SOL, s, fresh)).toMatchObject({ ok: true, amount: 2n * SOL });
  });

  it("no rule at all is refused", () => {
    const s: SizingSettings = { ...pct(0), percentBps: null };
    expect(sizeDeposit(1n * SOL, s, fresh)).toEqual({ ok: false, reason: "no_sizing_rule" });
  });

  it("per-position cap stops further adds", () => {
    const s: SizingSettings = { ...pct(5000), maxPerPosition: 1n * SOL };
    expect(sizeDeposit(4n * SOL, s, fresh)).toMatchObject({ amount: 1n * SOL, capped: "max_per_position" });
    expect(
      sizeDeposit(4n * SOL, s, { ratioPpm: 250_000n, depositedSol: 1n * SOL, fundedAt: new Date() }),
    ).toEqual({ ok: false, reason: "position_cap_reached" });
  });

  it("fixed SOL", () => {
    const s: SizingSettings = { ...pct(0), mode: "fixed_sol", percentBps: null, fixedSol: SOL / 2n };
    expect(sizeDeposit(10n * SOL, s, fresh)).toMatchObject({ ok: true, amount: SOL / 2n, ratioPpm: 50_000n });
  });

  it("suggested % = our net worth / leader's (LP Agent: 16.48 / 134.62 → ~12%)", () => {
    expect(suggestedPercentBps(16_480_000_000n, 134_620_000_000n)).toBe(1224);
  });
});
