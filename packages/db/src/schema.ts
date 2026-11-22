import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/*
 * Conventions
 * - Every tenant-owned table carries user_id (HANDOFF §12): one user today,
 *   several trusted users later, without a schema rewrite.
 * - SOL amounts are lamports (bigint). Token amounts are raw base units
 *   stored as numeric(40,0) because u64 * decimals can exceed bigint.
 * - Percentages are basis points (integer): 1400 = 14%.
 * - No private key material is ever stored here. agent_wallets only holds
 *   a reference to where the encrypted key lives on the server.
 */

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => ts("created_at").notNull().defaultNow();
const updatedAt = () => ts("updated_at").notNull().defaultNow().$onUpdate(() => new Date());
const lamports = (name: string) => bigint(name, { mode: "bigint" });
const rawAmount = (name: string) => numeric(name, { precision: 40, scale: 0 });

// ── Enums ────────────────────────────────────────────────────────────────
export const userRole = pgEnum("user_role", ["owner", "member"]);
export const leaderStatus = pgEnum("leader_status", ["active", "paused"]);
export const protocol = pgEnum("protocol", ["dlmm", "damm_v2"]);
export const sizingMode = pgEnum("sizing_mode", ["percent_of_leader", "fixed_sol"]);
export const valueCurrency = pgEnum("value_currency", ["sol", "usd"]);
export const managementMode = pgEnum("management_mode", [
  "mirror", // sadece aynala
  "staged_flip", // kademeli bid-ask flip (§3.1)
  "bottom_flip", // dipte flip (§3.2)
  "precision_hybrid", // %50 spot + %50 bid-ask + RL (§3.3)
]);
export const dlmmStrategy = pgEnum("dlmm_strategy", ["spot", "curve", "bid_ask", "custom"]);
export const positionState = pgEnum("position_state", [
  "OPENING",
  "ACTIVE",
  "FLIPPING",
  "CLOSING",
  "HOLDING", // closed, token kept by Smart Token Retention
  "CLOSED",
  "FAILED",
]);
export const txStatus = pgEnum("tx_status", [
  "planned", // dry-run: "şunu yapardım"
  "simulated",
  "submitted",
  "confirmed",
  "failed",
  "skipped",
]);
export const txKind = pgEnum("tx_kind", [
  "open",
  "add",
  "remove",
  "flip",
  "reshape",
  "claim",
  "compound",
  "close",
  "swap",
  "rebalance",
]);

// ── Users & wallets ──────────────────────────────────────────────────────
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Login wallet (Sign-In With Solana). Never the agent wallet. */
  loginWallet: text("login_wallet").notNull().unique(),
  displayName: text("display_name"),
  role: userRole("role").notNull().default("member"),
  telegramChatId: text("telegram_chat_id"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Per-user risk limits and the kill switch (HANDOFF §4 Genel, §6). */
export const userRiskSettings = pgTable("user_risk_settings", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  /** /stop sets this; nothing executes while true. */
  killSwitch: boolean("kill_switch").notNull().default(false),
  killSwitchReason: text("kill_switch_reason"),
  maxSolPerTx: lamports("max_sol_per_tx").notNull().default(sql`1000000000`),
  maxSolPerDay: lamports("max_sol_per_day").notNull().default(sql`10000000000`),
  /**
   * Fund protection (LP Agent model): max loss from peak, counted on CLOSED
   * copy positions only. The % is converted to a fixed SOL amount from net
   * worth at save time (fund_protection_loss_sol) and the count restarts.
   * When tripped: opens/adds/compounds/flips are blocked, exits still run.
   */
  fundProtectionEnabled: boolean("fund_protection_enabled").notNull().default(true),
  fundProtectionLossBps: integer("fund_protection_loss_bps").notNull().default(2000),
  fundProtectionLossSol: lamports("fund_protection_loss_sol"),
  fundProtectionSince: ts("fund_protection_since"),
  fundProtectionTrippedAt: ts("fund_protection_tripped_at"),

  // Account-wide token filters, applied before any open/add (LP Agent defaults).
  minOrganicScore: integer("min_organic_score").default(50),
  minMarketCapUsd: integer("min_market_cap_usd").default(500_000),
  min24hVolumeUsd: integer("min_24h_volume_usd").default(100_000),
  minHolders: integer("min_holders").default(100),
  tokenBlacklist: text("token_blacklist").array().notNull().default([]),

  /** Slippage for every swap the agent makes. */
  slippageBps: integer("slippage_bps").notNull().default(300),
  updatedAt: updatedAt(),
});

export const agentWallets = pgTable(
  "agent_wallets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    publicKey: text("public_key").notNull().unique(),
    /** Where the encrypted key lives (e.g. keystore file id). Never the key. */
    keystoreRef: text("keystore_ref").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("agent_wallets_user_idx").on(t.userId)],
);

// ── Leaders & copy settings ──────────────────────────────────────────────
export const leaders = pgTable(
  "leaders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    address: text("address").notNull(),
    label: text("label").notNull(),
    status: leaderStatus("status").notNull().default("active"),
    agentWalletId: uuid("agent_wallet_id").references(() => agentWallets.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("leaders_user_address_uq").on(t.userId, t.address),
    index("leaders_address_idx").on(t.address),
  ],
);

/** The 6-step Copy LP settings, one row per leader (HANDOFF §4). */
export const copySettings = pgTable("copy_settings", {
  leaderId: uuid("leader_id")
    .primaryKey()
    .references(() => leaders.id, { onDelete: "cascade" }),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),

  // 1. Boyut. If an open is capped by maxSolPerAdd, later leader adds to that
  //    position reuse the smaller share (positions.size_ratio_bps).
  sizingMode: sizingMode("sizing_mode").notNull().default("percent_of_leader"),
  sizingPercentBps: integer("sizing_percent_bps"),
  sizingFixedSol: lamports("sizing_fixed_sol"),
  maxSolPerPosition: lamports("max_sol_per_position"),
  maxSolPerAdd: lamports("max_sol_per_add"),

  // 2. Çıkış kuralları (TP/SL are snapshotted onto each position at open)
  exitWithLeader: boolean("exit_with_leader").notNull().default(true),
  /** Our difference from LP Agent: a paused leader's exits are still followed. */
  followExitsWhilePaused: boolean("follow_exits_while_paused").notNull().default(true),
  takeProfitBps: integer("take_profit_bps"),
  stopLossBps: integer("stop_loss_bps"),
  trailingStopBps: integer("trailing_stop_bps"),
  exitCurrency: valueCurrency("exit_currency").notNull().default("sol"),

  // 3. Ne kopyalanacak
  copyDlmmStrategies: dlmmStrategy("copy_dlmm_strategies")
    .array()
    .notNull()
    .default(["spot", "curve", "bid_ask", "custom"]),
  copyDammV2: boolean("copy_damm_v2").notNull().default(true),
  copyDlmmPro: boolean("copy_dlmm_pro").notNull().default(false),

  // 4. Koruma
  memeProtection: boolean("meme_protection").notNull().default(true),
  /** Meme Protection skips when > this share of the deposit is the untrusted token. */
  memeProtectionMaxUntrustedBps: integer("meme_protection_max_untrusted_bps").notNull().default(9500),
  // Smart Token Retention (DLMM only): keep pulled token briefly, reuse on re-add.
  smartTokenRetention: boolean("smart_token_retention").notNull().default(false),
  strHoldSeconds: integer("str_hold_seconds").notNull().default(60),
  strSellOnDropBps: integer("str_sell_on_drop_bps").notNull().default(500),
  strSellOnLeaderSell: boolean("str_sell_on_leader_sell").notNull().default(true),
  // Per-leader overrides of the account-wide token filters (null = use account value).
  minTokenAgeHours: integer("min_token_age_hours"),
  minMarketCapUsd: integer("min_market_cap_usd"),

  // 6. Pozisyon yönetimi
  managementMode: managementMode("management_mode").notNull().default("mirror"),
  /** Mode-specific knobs, e.g. { flipThresholdBps: 1400 } or { reshapeBins: 12 }. */
  managementParams: jsonb("management_params").$type<Record<string, unknown>>().notNull().default({}),
  compoundIntervalMinutes: integer("compound_interval_minutes"),
  convertFeesToSol: boolean("convert_fees_to_sol").notNull().default(false),

  updatedAt: updatedAt(),
});

// ── Chain events & positions ─────────────────────────────────────────────
/** Raw leader activity as decoded by the listener. Idempotent on (signature, ix_index). */
export const leaderEvents = pgTable(
  "leader_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    leaderId: uuid("leader_id")
      .notNull()
      .references(() => leaders.id, { onDelete: "cascade" }),
    protocol: protocol("protocol").notNull(),
    signature: text("signature").notNull(),
    ixIndex: integer("ix_index").notNull(),
    slot: bigint("slot", { mode: "bigint" }).notNull(),
    blockTime: ts("block_time"),
    /** IDL instruction name, e.g. add_liquidity_by_strategy2. */
    instruction: text("instruction").notNull(),
    pool: text("pool"),
    leaderPosition: text("leader_position"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    processedAt: ts("processed_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("leader_events_uq").on(t.userId, t.signature, t.ixIndex),
    index("leader_events_leader_idx").on(t.leaderId, t.createdAt),
  ],
);

export const positions = pgTable(
  "positions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    leaderId: uuid("leader_id").references(() => leaders.id, { onDelete: "set null" }),
    agentWalletId: uuid("agent_wallet_id").references(() => agentWallets.id),
    protocol: protocol("protocol").notNull(),
    pool: text("pool").notNull(),
    /** The leader position we mirror. */
    leaderPosition: text("leader_position"),
    /** Our on-chain position account (null while OPENING in dry-run). */
    ourPosition: text("our_position"),
    state: positionState("state").notNull().default("OPENING"),
    dryRun: boolean("dry_run").notNull(),
    strategy: dlmmStrategy("strategy"),
    managementMode: managementMode("management_mode").notNull(),
    lowerBinId: integer("lower_bin_id"),
    upperBinId: integer("upper_bin_id"),
    /** Our share of the leader position, ppm, fixed at first funding (LP Agent sizing rule). */
    sizeRatioPpm: bigint("size_ratio_ppm", { mode: "bigint" }),
    fundedAt: ts("funded_at"),
    entryActiveBinId: integer("entry_active_bin_id"),
    lastFlipBinId: integer("last_flip_bin_id"),
    depositedSol: lamports("deposited_sol").notNull().default(sql`0`),
    depositedToken: rawAmount("deposited_token").notNull().default("0"),
    /** High-water mark for the trailing stop, in exit currency. */
    peakValue: numeric("peak_value", { precision: 30, scale: 9 }),
    /** Dry-run only: the virtual bin-level position the manager simulates (see core/strategy/bins.ts). */
    simState: jsonb("sim_state").$type<Record<string, unknown>>(),
    lastManagedAt: ts("last_managed_at"),
    openedAt: ts("opened_at"),
    closedAt: ts("closed_at"),
    closeReason: text("close_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("positions_user_state_idx").on(t.userId, t.state),
    uniqueIndex("positions_leader_position_uq").on(t.userId, t.leaderPosition),
  ],
);

/** Every action we take or would take. idempotency_key guarantees one tx per intent. */
export const txs = pgTable(
  "txs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    positionId: uuid("position_id").references(() => positions.id, { onDelete: "set null" }),
    leaderEventId: uuid("leader_event_id").references(() => leaderEvents.id, {
      onDelete: "set null",
    }),
    idempotencyKey: text("idempotency_key").notNull(),
    kind: txKind("kind").notNull(),
    status: txStatus("status").notNull().default("planned"),
    dryRun: boolean("dry_run").notNull(),
    signature: text("signature"),
    attempts: integer("attempts").notNull().default(0),
    solDelta: lamports("sol_delta"),
    tokenDelta: rawAmount("token_delta"),
    /** Network + priority fees + rent, so the cost of flips/reshapes is visible (§3.4). */
    feeLamports: lamports("fee_lamports"),
    rentLamports: lamports("rent_lamports"),
    plan: jsonb("plan").$type<Record<string, unknown>>().notNull().default({}),
    /** Machine-readable reason for skipped/failed, e.g. meme_protection, low_balance, price_moved. */
    reason: text("reason"),
    error: text("error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("txs_idempotency_uq").on(t.userId, t.idempotencyKey),
    index("txs_position_idx").on(t.positionId),
    index("txs_user_created_idx").on(t.userId, t.createdAt),
  ],
);

export const pnlSnapshots = pgTable(
  "pnl_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    positionId: uuid("position_id")
      .notNull()
      .references(() => positions.id, { onDelete: "cascade" }),
    activeBinId: integer("active_bin_id"),
    valueSol: lamports("value_sol").notNull(),
    valueUsd: numeric("value_usd", { precision: 20, scale: 6 }),
    unclaimedFeeSol: lamports("unclaimed_fee_sol").notNull().default(sql`0`),
    claimedFeeSol: lamports("claimed_fee_sol").notNull().default(sql`0`),
    takenAt: ts("taken_at").notNull().defaultNow(),
  },
  (t) => [index("pnl_snapshots_position_idx").on(t.positionId, t.takenAt)],
);
