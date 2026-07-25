-- Project-removal cascade: give `machine_agent_terminals` and `machine_branches`
-- a real FK to their owning `machine_projects` row (they linked by `projectName`
-- TEXT only, so a project delete cascaded to NOTHING — forcing a manual teardown
-- enumeration that raced concurrent spawns / same-name re-creates, Codex
-- DD/EE/CC/V). With the FK (ON DELETE cascade, mirroring the existing
-- `machineBranchId` FK at 0191), deleting a project cascades to its sessions and
-- branches, and the EXISTING AFTER-DELETE reclaim triggers (0209/0219/0229) rescue
-- every Sprite pointer into `machine_sprite_reclaims`. No new trigger.
--
-- `projectName` is KEPT on both tables — the session-key HMAC and name lookups
-- depend on it; this only ADDS the cascade the text link never gave.

-- Nullable ADD COLUMN — machine-scope terminals have no project, and every
-- existing row starts NULL (a NULL FK is never validated).
ALTER TABLE "machine_branches" ADD COLUMN "machineProjectId" text;--> statement-breakpoint
ALTER TABLE "machine_agent_terminals" ADD COLUMN "machineProjectId" text;--> statement-breakpoint

-- Guarded FK add (0191 template): the column is all-NULL here, so the constraint
-- is validated instantly and never blocked by existing rows.
DO $$ BEGIN
 ALTER TABLE "machine_branches" ADD CONSTRAINT "machine_branches_machineProjectId_machine_projects_id_fk" FOREIGN KEY ("machineProjectId") REFERENCES "public"."machine_projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "machine_agent_terminals" ADD CONSTRAINT "machine_agent_terminals_machineProjectId_machine_projects_id_fk" FOREIGN KEY ("machineProjectId") REFERENCES "public"."machine_projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

-- Idempotent backfill from the (machineId, name) unique index. This schema is
-- net-new UNRELEASED (0219/0229 headers state no rows predate the feature), so a
-- backfill is not strictly required — but any dev/staging rows get the correct FK.
-- Guarded by `machineProjectId IS NULL` + the join, so it only ever sets a valid,
-- existing project id and re-runs are no-ops. Runs AFTER the constraint (every set
-- value is a real project id, so the per-row FK check passes).
UPDATE "machine_branches" b
  SET "machineProjectId" = mp."id"
  FROM "machine_projects" mp
  WHERE mp."machineId" = b."machineId" AND mp."name" = b."projectName" AND b."machineProjectId" IS NULL;--> statement-breakpoint
UPDATE "machine_agent_terminals" t
  SET "machineProjectId" = mp."id"
  FROM "machine_projects" mp
  WHERE t."projectName" IS NOT NULL AND mp."machineId" = t."machineId" AND mp."name" = t."projectName" AND t."machineProjectId" IS NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "machine_branches_project_id_idx" ON "machine_branches" USING btree ("machineProjectId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "machine_agent_terminals_project_id_idx" ON "machine_agent_terminals" USING btree ("machineProjectId");
