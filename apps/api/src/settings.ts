import { z } from "zod";
import type { schema } from "@binflip/db";
import { reshapeBinsFrom } from "@binflip/core";

/**
 * The copy dialog's 6 steps in UI units (%, SOL). The DB stores bps and
 * lamports; this is the only place that converts between the two.
 */
const pct = z.number().min(0).max(100_000);
const sol = z.number().min(0).max(100_000);
const opt = <T extends z.ZodTypeAny>(t: T) => t.nullable().optional();

export const CopySettingsDto = z.object({
  label: z.string().min(1).max(60).optional(),
  // 1. Boyut
  sizing: z
    .object({
      mode: z.enum(["percent_of_leader", "fixed_sol"]),
      percent: opt(pct.min(1).max(10_000)),
      fixedSol: opt(sol),
      maxPerTxSol: opt(sol.positive()),
      maxPerPositionSol: opt(sol.positive()),
    })
    .partial()
    .optional(),
  // 2. Çıkış kuralları
  exit: z
    .object({
      withLeader: z.boolean(),
      followExitsWhilePaused: z.boolean(),
      takeProfitPct: opt(pct),
      stopLossPct: opt(pct),
      trailingStopPct: opt(pct),
      currency: z.enum(["sol", "usd"]),
    })
    .partial()
    .optional(),
  // 3. Ne kopyalanacak
  copy: z
    .object({
      dlmmStrategies: z.array(z.enum(["spot", "curve", "bid_ask", "custom"])),
      dammV2: z.boolean(),
    })
    .partial()
    .optional(),
  // 4. Koruma
  protection: z
    .object({
      memeProtection: z.boolean(),
      smartTokenRetention: z.boolean(),
      strHoldSeconds: z.number().int().min(10).max(3600),
      strSellOnDropPct: pct.min(0.5).max(50),
      strSellOnLeaderSell: z.boolean(),
      minTokenAgeHours: opt(z.number().int().min(0)),
      minMarketCapUsd: opt(z.number().int().min(0)),
    })
    .partial()
    .optional(),
  // 6. Pozisyon yönetimi
  management: z
    .object({
      mode: z.enum(["mirror", "staged_flip", "bottom_flip", "precision_hybrid"]),
      flipThresholdPct: pct.min(1).max(90),
      reshapeBins: z.number().int().min(1).max(51),
      compoundMinutes: opt(z.number().int().min(5).max(7 * 24 * 60)),
      convertFeesToSol: z.boolean(),
    })
    .partial()
    .optional(),
});
export type CopySettingsDto = z.infer<typeof CopySettingsDto>;

type Row = typeof schema.copySettings.$inferSelect;
type Patch = Partial<typeof schema.copySettings.$inferInsert>;

const LAMPORTS = 1_000_000_000;
const toBps = (v: number | null | undefined) => (v === null || v === undefined ? null : Math.round(v * 100));
const fromBps = (v: number | null) => (v === null ? null : v / 100);
const toLamports = (v: number | null | undefined) => (v === null || v === undefined ? null : BigInt(Math.round(v * LAMPORTS)));
const fromLamports = (v: bigint | null) => (v === null ? null : Number(v) / LAMPORTS);
const has = (o: object | undefined, k: string) => !!o && Object.prototype.hasOwnProperty.call(o, k);

export function toRow(d: CopySettingsDto, currentParams: Record<string, unknown> = {}): Patch {
  const p: Patch = {};
  const s = d.sizing;
  if (s) {
    if (s.mode) p.sizingMode = s.mode;
    if (has(s, "percent")) p.sizingPercentBps = toBps(s.percent);
    if (has(s, "fixedSol")) p.sizingFixedSol = toLamports(s.fixedSol);
    if (has(s, "maxPerTxSol")) p.maxSolPerAdd = toLamports(s.maxPerTxSol);
    if (has(s, "maxPerPositionSol")) p.maxSolPerPosition = toLamports(s.maxPerPositionSol);
  }
  const e = d.exit;
  if (e) {
    if (e.withLeader !== undefined) p.exitWithLeader = e.withLeader;
    if (e.followExitsWhilePaused !== undefined) p.followExitsWhilePaused = e.followExitsWhilePaused;
    if (has(e, "takeProfitPct")) p.takeProfitBps = toBps(e.takeProfitPct);
    if (has(e, "stopLossPct")) p.stopLossBps = toBps(e.stopLossPct);
    if (has(e, "trailingStopPct")) p.trailingStopBps = toBps(e.trailingStopPct);
    if (e.currency) p.exitCurrency = e.currency;
  }
  const c = d.copy;
  if (c) {
    if (c.dlmmStrategies) p.copyDlmmStrategies = c.dlmmStrategies;
    if (c.dammV2 !== undefined) p.copyDammV2 = c.dammV2;
  }
  const pr = d.protection;
  if (pr) {
    if (pr.memeProtection !== undefined) p.memeProtection = pr.memeProtection;
    if (pr.smartTokenRetention !== undefined) p.smartTokenRetention = pr.smartTokenRetention;
    if (pr.strHoldSeconds !== undefined) p.strHoldSeconds = pr.strHoldSeconds;
    if (pr.strSellOnDropPct !== undefined) p.strSellOnDropBps = toBps(pr.strSellOnDropPct)!;
    if (pr.strSellOnLeaderSell !== undefined) p.strSellOnLeaderSell = pr.strSellOnLeaderSell;
    if (has(pr, "minTokenAgeHours")) p.minTokenAgeHours = pr.minTokenAgeHours ?? null;
    if (has(pr, "minMarketCapUsd")) p.minMarketCapUsd = pr.minMarketCapUsd ?? null;
  }
  const m = d.management;
  if (m) {
    if (m.mode) p.managementMode = m.mode;
    if (m.flipThresholdPct !== undefined || m.reshapeBins !== undefined) {
      p.managementParams = {
        ...currentParams,
        ...(m.flipThresholdPct !== undefined ? { flipThresholdBps: toBps(m.flipThresholdPct) } : {}),
        ...(m.reshapeBins !== undefined ? { reshapeBins: m.reshapeBins } : {}),
      };
    }
    if (has(m, "compoundMinutes")) p.compoundIntervalMinutes = m.compoundMinutes ?? null;
    if (m.convertFeesToSol !== undefined) p.convertFeesToSol = m.convertFeesToSol;
  }
  return p;
}

export function fromRow(r: Row) {
  const params = (r.managementParams ?? {}) as { flipThresholdBps?: number };
  return {
    sizing: {
      mode: r.sizingMode,
      percent: fromBps(r.sizingPercentBps),
      fixedSol: fromLamports(r.sizingFixedSol),
      maxPerTxSol: fromLamports(r.maxSolPerAdd),
      maxPerPositionSol: fromLamports(r.maxSolPerPosition),
    },
    exit: {
      withLeader: r.exitWithLeader,
      followExitsWhilePaused: r.followExitsWhilePaused,
      takeProfitPct: fromBps(r.takeProfitBps),
      stopLossPct: fromBps(r.stopLossBps),
      trailingStopPct: fromBps(r.trailingStopBps),
      currency: r.exitCurrency,
    },
    copy: { dlmmStrategies: r.copyDlmmStrategies, dammV2: r.copyDammV2 },
    protection: {
      memeProtection: r.memeProtection,
      smartTokenRetention: r.smartTokenRetention,
      strHoldSeconds: r.strHoldSeconds,
      strSellOnDropPct: r.strSellOnDropBps / 100,
      strSellOnLeaderSell: r.strSellOnLeaderSell,
      minTokenAgeHours: r.minTokenAgeHours,
      minMarketCapUsd: r.minMarketCapUsd,
    },
    management: {
      mode: r.managementMode,
      flipThresholdPct: (params.flipThresholdBps ?? 1000) / 100,
      reshapeBins: reshapeBinsFrom(params),
      compoundMinutes: r.compoundIntervalMinutes,
      convertFeesToSol: r.convertFeesToSol,
    },
  };
}
