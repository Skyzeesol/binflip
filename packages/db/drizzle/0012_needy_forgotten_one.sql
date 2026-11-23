ALTER TABLE "positions" ADD COLUMN "origin" text;--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "fee_mode" text;--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "compound_minutes" integer;--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "management_params" jsonb;