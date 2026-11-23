import { describe, expect, it } from "vitest";
import { checkTokenFilters, type TokenFilters, type TokenInfo } from "./tokenFilters.js";

const now = new Date("2026-11-23T12:00:00Z");
const cate: TokenInfo = { mint: "Ai66", symbol: "CATE", organicScore: 78.6, mcapUsd: 19_256_405, volume24hUsd: 1_201_410, holders: 143_313, usdPrice: 0.019, createdAt: new Date("2026-07-26T16:24:38Z") };
// LP Agent defaults for new accounts
const lpAgent: TokenFilters = { minOrganicScore: 50, minMarketCapUsd: 500_000, min24hVolumeUsd: 100_000, minHolders: 100, minTokenAgeHours: null, blacklist: [] };

describe("token filters (LP Agent Security settings)", () => {
  it("a healthy token passes the LP Agent defaults", () => {
    expect(checkTokenFilters(cate, lpAgent, now)).toEqual({ ok: true });
  });
  it("each floor can reject", () => {
    expect(checkTokenFilters({ ...cate, organicScore: 30 }, lpAgent, now)).toMatchObject({ reason: "token_filter" });
    expect(checkTokenFilters({ ...cate, mcapUsd: 200_000 }, lpAgent, now)).toMatchObject({ reason: "token_filter" });
    expect(checkTokenFilters({ ...cate, volume24hUsd: 5_000 }, lpAgent, now)).toMatchObject({ reason: "token_filter" });
    expect(checkTokenFilters({ ...cate, holders: 40 }, lpAgent, now)).toMatchObject({ reason: "token_filter" });
  });
  it("unknown data fails an active floor (fail closed)", () => {
    expect(checkTokenFilters({ ...cate, organicScore: null }, lpAgent, now)).toMatchObject({ ok: false });
  });
  it("0 / null means no floor (LP Agent: 'Set 0 for no floor')", () => {
    expect(checkTokenFilters({ ...cate, holders: 3 }, { ...lpAgent, minHolders: 0 }, now)).toEqual({ ok: true });
  });
  it("blacklist wins", () => {
    expect(checkTokenFilters(cate, { ...lpAgent, blacklist: ["Ai66"] }, now)).toMatchObject({ reason: "token_blacklisted" });
  });
  it("token age floor (HANDOFF: 2-3 days)", () => {
    expect(checkTokenFilters({ ...cate, createdAt: new Date("2026-11-22T12:00:00Z") }, { ...lpAgent, minTokenAgeHours: 48 }, now)).toMatchObject({ reason: "token_filter" });
  });
});
