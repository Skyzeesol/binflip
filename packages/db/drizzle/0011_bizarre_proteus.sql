ALTER TYPE "public"."tx_kind" ADD VALUE 'withdraw';--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "mint_x" text;--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "mint_y" text;--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "bin_step" integer;--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "active_bin_id" integer;--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "unclaimed_fee_sol" numeric(30, 9);--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "claimed_fee_sol" numeric(30, 9) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "compounded_fee_sol" numeric(30, 9) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "chain_bins" jsonb;