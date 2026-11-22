CREATE TYPE "public"."dlmm_strategy" AS ENUM('spot', 'curve', 'bid_ask', 'custom');--> statement-breakpoint
CREATE TYPE "public"."leader_status" AS ENUM('active', 'paused');--> statement-breakpoint
CREATE TYPE "public"."management_mode" AS ENUM('mirror', 'staged_flip', 'bottom_flip', 'precision_hybrid');--> statement-breakpoint
CREATE TYPE "public"."position_state" AS ENUM('OPENING', 'ACTIVE', 'FLIPPING', 'CLOSING', 'CLOSED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."protocol" AS ENUM('dlmm', 'damm_v2');--> statement-breakpoint
CREATE TYPE "public"."sizing_mode" AS ENUM('percent_of_leader', 'fixed_sol');--> statement-breakpoint
CREATE TYPE "public"."tx_kind" AS ENUM('open', 'add', 'remove', 'flip', 'reshape', 'claim', 'compound', 'close', 'swap');--> statement-breakpoint
CREATE TYPE "public"."tx_status" AS ENUM('planned', 'simulated', 'submitted', 'confirmed', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('owner', 'member');--> statement-breakpoint
CREATE TYPE "public"."value_currency" AS ENUM('sol', 'usd');--> statement-breakpoint
CREATE TABLE "agent_wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"label" text NOT NULL,
	"public_key" text NOT NULL,
	"keystore_ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_wallets_public_key_unique" UNIQUE("public_key")
);
--> statement-breakpoint
CREATE TABLE "copy_settings" (
	"leader_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"sizing_mode" "sizing_mode" DEFAULT 'percent_of_leader' NOT NULL,
	"sizing_percent_bps" integer,
	"sizing_fixed_sol" bigint,
	"max_sol_per_position" bigint,
	"max_sol_per_add" bigint,
	"exit_with_leader" boolean DEFAULT true NOT NULL,
	"take_profit_bps" integer,
	"stop_loss_bps" integer,
	"trailing_stop_bps" integer,
	"exit_currency" "value_currency" DEFAULT 'sol' NOT NULL,
	"copy_dlmm_strategies" "dlmm_strategy"[] DEFAULT '{"spot","curve","bid_ask","custom"}' NOT NULL,
	"copy_damm_v2" boolean DEFAULT false NOT NULL,
	"copy_dlmm_pro" boolean DEFAULT false NOT NULL,
	"meme_protection" boolean DEFAULT true NOT NULL,
	"smart_token_retention" boolean DEFAULT false NOT NULL,
	"min_token_age_hours" integer,
	"min_market_cap_usd" integer,
	"management_mode" "management_mode" DEFAULT 'mirror' NOT NULL,
	"management_params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"compound_interval_minutes" integer,
	"convert_fees_to_sol" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leader_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"leader_id" uuid NOT NULL,
	"protocol" "protocol" NOT NULL,
	"signature" text NOT NULL,
	"ix_index" integer NOT NULL,
	"slot" bigint NOT NULL,
	"block_time" timestamp with time zone,
	"instruction" text NOT NULL,
	"pool" text,
	"leader_position" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leaders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"address" text NOT NULL,
	"label" text NOT NULL,
	"status" "leader_status" DEFAULT 'active' NOT NULL,
	"agent_wallet_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pnl_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"position_id" uuid NOT NULL,
	"active_bin_id" integer,
	"value_sol" bigint NOT NULL,
	"value_usd" numeric(20, 6),
	"unclaimed_fee_sol" bigint DEFAULT 0 NOT NULL,
	"claimed_fee_sol" bigint DEFAULT 0 NOT NULL,
	"taken_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"leader_id" uuid,
	"agent_wallet_id" uuid,
	"protocol" "protocol" NOT NULL,
	"pool" text NOT NULL,
	"leader_position" text,
	"our_position" text,
	"state" "position_state" DEFAULT 'OPENING' NOT NULL,
	"dry_run" boolean NOT NULL,
	"strategy" "dlmm_strategy",
	"management_mode" "management_mode" NOT NULL,
	"lower_bin_id" integer,
	"upper_bin_id" integer,
	"size_ratio_bps" integer,
	"entry_active_bin_id" integer,
	"last_flip_bin_id" integer,
	"deposited_sol" bigint DEFAULT 0 NOT NULL,
	"deposited_token" numeric(40, 0) DEFAULT '0' NOT NULL,
	"peak_value" numeric(30, 9),
	"opened_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"close_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "txs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"position_id" uuid,
	"leader_event_id" uuid,
	"idempotency_key" text NOT NULL,
	"kind" "tx_kind" NOT NULL,
	"status" "tx_status" DEFAULT 'planned' NOT NULL,
	"dry_run" boolean NOT NULL,
	"signature" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"sol_delta" bigint,
	"token_delta" numeric(40, 0),
	"fee_lamports" bigint,
	"rent_lamports" bigint,
	"plan" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_risk_settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"kill_switch" boolean DEFAULT false NOT NULL,
	"kill_switch_reason" text,
	"max_sol_per_tx" bigint DEFAULT 1000000000 NOT NULL,
	"max_sol_per_day" bigint DEFAULT 10000000000 NOT NULL,
	"fund_protection_loss_sol" bigint,
	"fund_protection_loss_bps" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"login_wallet" text NOT NULL,
	"display_name" text,
	"role" "user_role" DEFAULT 'member' NOT NULL,
	"telegram_chat_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_login_wallet_unique" UNIQUE("login_wallet")
);
--> statement-breakpoint
ALTER TABLE "agent_wallets" ADD CONSTRAINT "agent_wallets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_settings" ADD CONSTRAINT "copy_settings_leader_id_leaders_id_fk" FOREIGN KEY ("leader_id") REFERENCES "public"."leaders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_settings" ADD CONSTRAINT "copy_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leader_events" ADD CONSTRAINT "leader_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leader_events" ADD CONSTRAINT "leader_events_leader_id_leaders_id_fk" FOREIGN KEY ("leader_id") REFERENCES "public"."leaders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leaders" ADD CONSTRAINT "leaders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leaders" ADD CONSTRAINT "leaders_agent_wallet_id_agent_wallets_id_fk" FOREIGN KEY ("agent_wallet_id") REFERENCES "public"."agent_wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pnl_snapshots" ADD CONSTRAINT "pnl_snapshots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pnl_snapshots" ADD CONSTRAINT "pnl_snapshots_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_leader_id_leaders_id_fk" FOREIGN KEY ("leader_id") REFERENCES "public"."leaders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_agent_wallet_id_agent_wallets_id_fk" FOREIGN KEY ("agent_wallet_id") REFERENCES "public"."agent_wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "txs" ADD CONSTRAINT "txs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "txs" ADD CONSTRAINT "txs_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "txs" ADD CONSTRAINT "txs_leader_event_id_leader_events_id_fk" FOREIGN KEY ("leader_event_id") REFERENCES "public"."leader_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_risk_settings" ADD CONSTRAINT "user_risk_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_wallets_user_idx" ON "agent_wallets" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "leader_events_uq" ON "leader_events" USING btree ("user_id","signature","ix_index");--> statement-breakpoint
CREATE INDEX "leader_events_leader_idx" ON "leader_events" USING btree ("leader_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "leaders_user_address_uq" ON "leaders" USING btree ("user_id","address");--> statement-breakpoint
CREATE INDEX "leaders_address_idx" ON "leaders" USING btree ("address");--> statement-breakpoint
CREATE INDEX "pnl_snapshots_position_idx" ON "pnl_snapshots" USING btree ("position_id","taken_at");--> statement-breakpoint
CREATE INDEX "positions_user_state_idx" ON "positions" USING btree ("user_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "positions_leader_position_uq" ON "positions" USING btree ("user_id","leader_position");--> statement-breakpoint
CREATE UNIQUE INDEX "txs_idempotency_uq" ON "txs" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "txs_position_idx" ON "txs" USING btree ("position_id");--> statement-breakpoint
CREATE INDEX "txs_user_created_idx" ON "txs" USING btree ("user_id","created_at");