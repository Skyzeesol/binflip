CREATE TABLE "manual_settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"management_mode" "management_mode" DEFAULT 'staged_flip' NOT NULL,
	"management_params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"take_profit_bps" integer,
	"stop_loss_bps" integer,
	"trailing_stop_bps" integer,
	"compound_interval_minutes" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "manual_settings" ADD CONSTRAINT "manual_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;