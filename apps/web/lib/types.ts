export type Strategy = "spot" | "curve" | "bid_ask" | "custom";
export type ManagementMode = "mirror" | "staged_flip" | "bottom_flip" | "precision_hybrid";

export interface CopySettings {
  sizing: { mode: "percent_of_leader" | "fixed_sol"; percent: number | null; fixedSol: number | null; maxPerTxSol: number | null; maxPerPositionSol: number | null };
  exit: { withLeader: boolean; followExitsWhilePaused: boolean; takeProfitPct: number | null; stopLossPct: number | null; trailingStopPct: number | null; currency: "sol" | "usd" };
  copy: { dlmmStrategies: Strategy[]; dammV2: boolean };
  protection: {
    memeProtection: boolean;
    smartTokenRetention: boolean;
    strHoldSeconds: number;
    strSellOnDropPct: number;
    strSellOnLeaderSell: boolean;
    minTokenAgeHours: number | null;
    minMarketCapUsd: number | null;
  };
  management: { mode: ManagementMode; flipThresholdPct: number; reshapeBins?: number; compoundMinutes: number | null; convertFeesToSol: boolean };
}

export interface Leader {
  id: string;
  address: string;
  label: string;
  status: "active" | "paused";
  settings: CopySettings;
  positions: number;
  pnlSol: number;
  lastActivity: string | null;
}

export interface LogRow {
  id: string;
  time: string;
  kind: string;
  result: "Open" | "Closed" | "Holding" | "NotOpened" | "Skipped" | "Failed" | "Pending";
  status: string;
  reason: string | null;
  error: string | null;
  dryRun: boolean;
  solDelta: number | null;
  feeSol: number | null;
  signature: string | null;
  plan: Record<string, unknown>;
  source: { id: string | null; label: string; status: string | null; position: string | null };
  position: { id: string; pool: string; state: string; ourPosition: string | null; depositedSol: number | null; valueSol: number | null; closeReason: string | null } | null;
  leaderTx: string | null;
}

export interface Analysis {
  range: string;
  totals: { pnlSol: number; opened: number; networkFeesSol: number };
  wallets: Array<{ leaderId: string | null; label: string; opened: number; open: number; depositedSol: number; pnlSol: number }>;
  series: Array<{ day: string; leaderId: string | null; pnlSol: number }>;
}

export interface Position {
  id: string;
  source: string;
  pool: string;
  ourPosition: string | null;
  leaderPosition: string | null;
  state: string;
  dryRun: boolean;
  strategy: string | null;
  managementMode: ManagementMode;
  range: [number | null, number | null];
  depositedSol: number | null;
  valueSol: number | null;
  pnlPct: number | null;
  flips: number | null;
  openedAt: string | null;
  closedAt: string | null;
  closeReason: string | null;
}

export interface Risk {
  killSwitch: boolean;
  killSwitchReason: string | null;
  maxSolPerTx: number;
  maxSolPerDay: number;
  fundProtectionEnabled: boolean;
  fundProtectionLossPct: number;
  fundProtectionTrippedAt: string | null;
  fundProtectionLimitSol: number | null;
  slippagePct: number;
  minOrganicScore: number | null;
  minMarketCapUsd: number | null;
  min24hVolumeUsd: number | null;
  minHolders: number | null;
  tokenBlacklist: string[];
}

export interface Me {
  user: { id: string; loginWallet: string; role: string };
  mode: "dry_run" | "live";
  agentWallets: Array<{ id: string; label: string; publicKey: string }>;
}

// ── Portfolio (LP Agent "Portfolio") ───────────────────────────────────
export interface PfToken {
  mint: string;
  symbol: string | null;
  icon: string | null;
  holders: number | null;
}

export interface PfPosition {
  id: string;
  protocol: "dlmm" | "damm_v2";
  pool: string;
  position: string | null;
  leaderPosition: string | null;
  source: "auto" | "manual";
  leaderLabel: string | null;
  dryRun: boolean;
  state: string;
  strategy: Strategy | null;
  managementMode: ManagementMode;
  token: PfToken | null;
  invested: number;
  value: number | null;
  claimedFee: number;
  unclaimedFee: number | null;
  totalFee: number;
  feePct: number | null;
  pnl: number | null;
  pnlPct: number | null;
  ageMs: number | null;
  dpr: number | null;
  range: { lowerPct: number; upperPct: number; inRange: boolean; bins: number } | null;
  bins: { lower: number | null; upper: number | null; active: number | null; binStep: number | null };
  exits: { takeProfitPct: number | null; stopLossPct: number | null; trailingPct: number | null };
  flips: number | null;
  openedAt: string;
  closedAt: string | null;
  closeReason: string | null;
}

export interface PfSummary {
  totalClosed: number;
  winRate: number | null;
  avgInvested: number | null;
  feeEarned: number;
  totalProfit: number;
  avgMonthlyProfit: number | null;
  expectedValue: number | null;
}

export interface PfBucket {
  bucket: string;
  value: number;
  count: number;
}

export interface Portfolio {
  summary: PfSummary;
  openValue: number;
  openUnclaimed: number;
  history: { pnl: PfBucket[]; fee: PfBucket[] };
  days: PfBucket[];
  feeDays?: PfBucket[];
}

export interface PfDetail {
  position: PfPosition;
  chart: { active: number | null; bins: Array<{ id: number; x: number; y: number }> };
  value: Array<{ at: string; value: number }>;
  history: Array<{ at: string; kind: string; status: string; reason: string | null; signature: string | null; signatures: string[]; solDelta: number | null; feeLamports: number | null; dryRun: boolean }>;
  logs: Array<{ at: string; kind: string; status: string; reason: string | null; error: string | null }>;
}

export interface Account {
  wallet: string | null;
  mainWallet: string | null;
  solUsd: number | null;
  positionsValue: number;
  mode: "dry_run" | "live";
  sol: number | null;
  tokens: Array<{ mint: string; symbol: string | null; icon: string | null; amount: number; valueSol: number | null }>;
  tokensValue: number;
  netWorth: number;
  emptyAccounts?: number;
  claimableSol?: number;
  error?: string;
}

export interface Prefs {
  notify: Record<string, boolean>;
  autoTpSl: { enabled: boolean; takeProfitPct: number; stopLossPct: number };
}
