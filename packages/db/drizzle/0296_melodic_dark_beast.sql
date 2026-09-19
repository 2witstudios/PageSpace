ALTER TABLE "agent_workspaces" ADD COLUMN "kind" text DEFAULT 'agent' NOT NULL;--> statement-breakpoint
-- Plain build, per precedent (0255 built the chat-target partial index the
-- same way on a populated table): the partial slice this scans is tiny, and
-- the migration runner has no non-transactional path for CONCURRENTLY.
CREATE UNIQUE INDEX "agent_workspaces_one_open_dashboard_idx" ON "agent_workspaces" USING btree ("ownerId") WHERE "agent_workspaces"."kind" = 'dashboard' AND "agent_workspaces"."endedAt" IS NULL;--> statement-breakpoint
-- NOT VALID per the repo's two-stage rule for checks on POPULATED tables
-- (0249/0250 -> 0251): enforced for every new row from the moment this lands;
-- the legacy corpus satisfies it vacuously (kind defaults 'agent' everywhere),
-- so VALIDATE is staged for the rule, not because the corpus is in doubt.
ALTER TABLE "agent_workspaces" ADD CONSTRAINT "agent_workspaces_kind_values_check" CHECK ("agent_workspaces"."kind" IN ('agent', 'dashboard')) NOT VALID;--> statement-breakpoint
-- NOT VALID, same two-stage rule as above (both halves vacuously true of
-- the shipped corpus: no 'dashboard' rows exist until this feature ships).
ALTER TABLE "agent_workspaces" ADD CONSTRAINT "agent_workspaces_dashboard_shape_check" CHECK ("agent_workspaces"."kind" <> 'dashboard' OR ("agent_workspaces"."driveId" IS NULL AND "agent_workspaces"."envId" IS NULL AND "agent_workspaces"."sandboxId" IS NULL AND "agent_workspaces"."spriteKey" IS NULL AND "agent_workspaces"."spriteInstanceId" IS NULL)) NOT VALID;