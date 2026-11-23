ALTER TABLE "copy_settings" ALTER COLUMN "follow_exits_while_paused" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "take_profit_bps" integer;--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "stop_loss_bps" integer;--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "trailing_stop_bps" integer;--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "exit_rules_saved" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- LP Agent parity (§22 A): pausing stops closes too, for existing copies as well.
UPDATE "copy_settings" SET "follow_exits_while_paused" = false;
