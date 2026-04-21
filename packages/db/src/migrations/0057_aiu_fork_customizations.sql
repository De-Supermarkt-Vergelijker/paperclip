ALTER TABLE "agents" ADD COLUMN "last_timer_heartbeat_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "instructions_hash_before" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "scheduled_for" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "issues_status_scheduled_for_idx" ON "issues" USING btree ("status","scheduled_for");