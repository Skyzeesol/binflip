import { describe, expect, it } from "vitest";
import { CopySettingsDto, fromRow, toRow } from "./settings.js";

describe("copy settings DTO ↔ row", () => {
  it("converts UI units (%, SOL) to bps and lamports", () => {
    const p = toRow(
      CopySettingsDto.parse({
        sizing: { mode: "percent_of_leader", percent: 50, maxPerTxSol: 2.5 },
        exit: { takeProfitPct: 5, stopLossPct: 5, trailingStopPct: null },
        management: { mode: "staged_flip", flipThresholdPct: 10, compoundMinutes: 60 },
      }),
      { other: 1 },
    );
    expect(p).toMatchObject({
      sizingMode: "percent_of_leader",
      sizingPercentBps: 5000,
      maxSolPerAdd: 2_500_000_000n,
      takeProfitBps: 500,
      stopLossBps: 500,
      trailingStopBps: null,
      managementMode: "staged_flip",
      managementParams: { other: 1, flipThresholdBps: 1000 },
      compoundIntervalMinutes: 60,
    });
  });

  it("only touches the fields that were sent", () => {
    expect(toRow(CopySettingsDto.parse({ exit: { takeProfitPct: 7 } }))).toEqual({ takeProfitBps: 700 });
  });

  it("rejects out-of-range values (e.g. copy % below LP Agent's 1% floor)", () => {
    expect(() => CopySettingsDto.parse({ sizing: { percent: 0.5 } })).toThrow();
    expect(() => CopySettingsDto.parse({ sizing: { maxPerTxSol: 0 } })).toThrow(); // a 0 max would copy nothing
  });

  it("round-trips", () => {
    const row = {
      leaderId: "l",
      userId: "u",
      sizingMode: "percent_of_leader",
      sizingPercentBps: 2800,
      sizingFixedSol: null,
      maxSolPerPosition: null,
      maxSolPerAdd: 1_000_000_000n,
      exitWithLeader: true,
      followExitsWhilePaused: true,
      takeProfitBps: null,
      stopLossBps: 1000,
      trailingStopBps: 500,
      exitCurrency: "sol",
      copyDlmmStrategies: ["spot", "bid_ask"],
      copyDammV2: true,
      copyDlmmPro: false,
      memeProtection: true,
      memeProtectionMaxUntrustedBps: 9500,
      smartTokenRetention: false,
      strHoldSeconds: 60,
      strSellOnDropBps: 500,
      strSellOnLeaderSell: true,
      minTokenAgeHours: null,
      minMarketCapUsd: null,
      managementMode: "staged_flip",
      managementParams: { flipThresholdBps: 1200 },
      compoundIntervalMinutes: null,
      convertFeesToSol: false,
      updatedAt: new Date(),
    } as const;
    const dto = fromRow(row as never);
    expect(dto.sizing).toMatchObject({ percent: 28, maxPerTxSol: 1 });
    expect(dto.management.flipThresholdPct).toBe(12);
    expect(toRow(CopySettingsDto.parse(dto))).toMatchObject({ sizingPercentBps: 2800, maxSolPerAdd: 1_000_000_000n, stopLossBps: 1000, trailingStopBps: 500 });
  });
});
