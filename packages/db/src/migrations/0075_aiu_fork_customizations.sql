-- AIU fork customizations consolidated for v2026.428.0 rebase.
-- All ALTER statements use IF NOT EXISTS so prod (which already has these
-- columns from the v2026.416.0-era 0057_aiu_fork_customizations) is a no-op,
-- while fresh installs receive the schema additions.
--
-- Source columns by fork commit:
--   - agents.last_timer_heartbeat_at         <- 9accb965 (heartbeat lastTimerHeartbeatAt)
--   - heartbeat_runs.instructions_hash_before <- 44d067ef (instructions-hash session rotation)
--   - issues.scheduled_for                    <- 05b94724 (native scheduledFor + cron)
--   - issues_status_scheduled_for_idx         <- 05b94724 (auto-backlog cron lookup)
--
-- See: skills/upstream-contribution/SKILL.md §29c (reconcile-prevention).
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "last_timer_heartbeat_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "instructions_hash_before" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "scheduled_for" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issues_status_scheduled_for_idx" ON "issues" USING btree ("status","scheduled_for");
