ALTER TABLE "positions" ADD COLUMN "sim_state" jsonb;--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "last_managed_at" timestamp with time zone;