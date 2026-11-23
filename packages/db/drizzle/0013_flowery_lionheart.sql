CREATE TABLE "smart_wallets" (
	"address" text PRIMARY KEY NOT NULL,
	"total_pnl_sol" numeric(30, 9) DEFAULT '0' NOT NULL,
	"win_rate" numeric(9, 4),
	"closed_positions" integer DEFAULT 0 NOT NULL,
	"fees_sol" numeric(30, 9) DEFAULT '0' NOT NULL,
	"pnl_7d_sol" numeric(30, 9) DEFAULT '0' NOT NULL,
	"pnl_30d_sol" numeric(30, 9) DEFAULT '0' NOT NULL,
	"monthly_sol" numeric(30, 9),
	"ev_sol" numeric(30, 9),
	"avg_invested_sol" numeric(30, 9),
	"open_value_sol" numeric(30, 9) DEFAULT '0' NOT NULL,
	"fee_checked" boolean DEFAULT false NOT NULL,
	"last_active_at" timestamp with time zone,
	"open_pools" text[] DEFAULT '{}' NOT NULL,
	"open_tokens" text[] DEFAULT '{}' NOT NULL,
	"daily" jsonb,
	"sampled_pools" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "smart_wallets_pnl_idx" ON "smart_wallets" USING btree ("total_pnl_sol");--> statement-breakpoint
CREATE INDEX "smart_wallets_updated_idx" ON "smart_wallets" USING btree ("updated_at");