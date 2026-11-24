import { describe, expect, it } from "vitest";
import type { OpenJob } from "@binflip/core";
import { OpenWizard, type TokenPool } from "./wizard.js";

const MINT = "6aiyJ9uwGYRE3tM6rk7oeqLwpdDcdtVgU7aW2mFFpump";
const POOL_A = "FTAYKMfiug11f6Adogu9bYPxPfYhdCSGTxy6D91AXZTa";
const pool = (address: string, over: Partial<TokenPool> = {}): TokenPool => ({
  address, protocol: "dlmm", name: "cCAT/SOL", tvl: 6000, feeTvl24h: 15, feeTvl1h: 3, volume24h: 31000, binStep: 100, baseFee: 2, solIsY: true, hasSol: true, ...over,
});

function setup() {
  const jobs: OpenJob[] = [];
  const queue = { add: async (_n: string, j: OpenJob) => (jobs.push(j), {}) } as never;
  const w = new OpenWizard(queue, async () => "user-1", async (a) => (a === POOL_A ? pool(POOL_A) : null), async () => ({
    symbol: "cCAT",
    pools: [pool(POOL_A), pool("B".repeat(43), { binStep: 20, baseFee: 0.25, tvl: 3000, feeTvl24h: 40 })],
  }));
  return { w, jobs };
}

describe("telegram open wizard", () => {
  it("token CA → pick pool → amount → % below → strategy → fees → management → TP/SL → queued", async () => {
    const { w, jobs } = setup();
    const list = (await w.onText("c", MINT))!;
    expect(list.text).toContain("2 SOL havuzu");
    expect(list.text).toContain("⭐");
    expect((await w.onText("c", "1"))!.text).toContain("Kaç SOL");
    expect((await w.onText("c", "0,5"))!.text).toContain("yüzde kaç");
    expect((await w.onText("c", "40"))!.text).toContain("Strateji");
    expect((await w.answer("c", "str:bid_ask")).text).toContain("Fee");
    expect((await w.answer("c", "fee:sell")).text).toContain("yönetelim");
    expect((await w.answer("c", "mng:staged_flip:12")).text).toContain("TP / SL");
    const sum = (await w.onText("c", "15/10"))!;
    expect(sum.text).toContain("TP %15 · SL %10");
    await w.answer("c", "ok");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ pool: POOL_A, lamports: "500000000", lowerPct: -40, upperPct: 0, strategy: "bid_ask", feeMode: "sell", managementMode: "staged_flip", flipThresholdBps: 1200, takeProfitBps: 1500, stopLossBps: 1000, origin: "telegram" });
  });

  it("a pool address skips the pool question; default TP/SL leaves exits to Settings", async () => {
    const { w, jobs } = setup();
    expect((await w.onText("c", `https://app.meteora.ag/dlmm/${POOL_A}`))!.text).toContain("Kaç SOL");
    await w.answer("c", "amt:1");
    await w.answer("c", "rng:50");
    await w.answer("c", "str:spot");
    await w.answer("c", "fee:compound");
    await w.answer("c", "mng:precision_hybrid:12");
    expect((await w.answer("c", "ex:def")).text).toContain("Auto TP/SL");
    await w.answer("c", "ok");
    expect(jobs[0]!.takeProfitBps).toBeUndefined();
    expect(jobs[0]!.reshapeBins).toBe(12);
  });

  it("unknown address", async () => {
    const jobs: OpenJob[] = [];
    const w = new OpenWizard({ add: async (_n: string, j: OpenJob) => jobs.push(j) } as never, async () => "u", async () => null, async () => ({ symbol: "", pools: [] }));
    expect((await w.onText("c", MINT))!.text).toContain("bulamadım");
  });
});
