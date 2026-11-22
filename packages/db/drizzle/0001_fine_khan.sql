ALTER TYPE "public"."position_state" ADD VALUE 'HOLDING' BEFORE 'CLOSED';--> statement-breakpoint
ALTER TABLE "copy_settings" ALTER COLUMN "copy_damm_v2" SET DEFAULT true;--> statement-breakpoint
ALTER TABLE "user_risk_settings" ALTER COLUMN "fund_protection_loss_bps" SET DEFAULT 2000;--> statement-breakpoint
ALTER TABLE "user_risk_settings" ALTER COLUMN "fund_protection_loss_bps" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "copy_settings" ADD COLUMN "follow_exits_while_paused" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "copy_settings" ADD COLUMN "meme_protection_max_untrusted_bps" integer DEFAULT 9500 NOT NULL;--> statement-breakpoint
ALTER TABLE "copy_settings" ADD COLUMN "str_hold_seconds" integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE "copy_settings" ADD COLUMN "str_sell_on_drop_bps" integer DEFAULT 500 NOT NULL;--> statement-breakpoint
ALTER TABLE "copy_settings" ADD COLUMN "str_sell_on_leader_sell" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "txs" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "user_risk_settings" ADD COLUMN "fund_protection_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_risk_settings" ADD COLUMN "fund_protection_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user_risk_settings" ADD COLUMN "fund_protection_tripped_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user_risk_settings" ADD COLUMN "min_organic_score" integer DEFAULT 50;--> statement-breakpoint
ALTER TABLE "user_risk_settings" ADD COLUMN "min_market_cap_usd" integer DEFAULT 500000;--> statement-breakpoint
ALTER TABLE "user_risk_settings" ADD COLUMN "min_24h_volume_usd" integer DEFAULT 100000;--> statement-breakpoint
ALTER TABLE "user_risk_settings" ADD COLUMN "min_holders" integer DEFAULT 100;--> statement-breakpoint
ALTER TABLE "user_risk_settings" ADD COLUMN "token_blacklist" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_risk_settings" ADD COLUMN "slippage_bps" integer DEFAULT 300 NOT NULL;