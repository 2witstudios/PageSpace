ALTER TYPE "PageType" RENAME VALUE 'TERMINAL' TO 'MACHINE';--> statement-breakpoint
ALTER TABLE "machine_projects" RENAME COLUMN "terminalId" TO "machineId";--> statement-breakpoint
ALTER TABLE "machine_branches" RENAME COLUMN "terminalId" TO "machineId";--> statement-breakpoint
ALTER TABLE "machine_agent_terminals" RENAME COLUMN "terminalId" TO "machineId";--> statement-breakpoint
ALTER TABLE "machine_projects" DROP CONSTRAINT "machine_projects_terminalId_pages_id_fk";
--> statement-breakpoint
ALTER TABLE "machine_branches" DROP CONSTRAINT "machine_branches_terminalId_pages_id_fk";
--> statement-breakpoint
ALTER TABLE "machine_agent_terminals" DROP CONSTRAINT "machine_agent_terminals_terminalId_pages_id_fk";
--> statement-breakpoint
DROP INDEX IF EXISTS "machine_projects_terminal_id_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "machine_projects_terminal_id_name_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "machine_branches_terminal_id_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "machine_branches_terminal_project_branch_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "machine_agent_terminals_terminal_id_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "machine_agent_terminals_scope_name_idx";--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "machine_projects" ADD CONSTRAINT "machine_projects_machineId_pages_id_fk" FOREIGN KEY ("machineId") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "machine_branches" ADD CONSTRAINT "machine_branches_machineId_pages_id_fk" FOREIGN KEY ("machineId") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "machine_agent_terminals" ADD CONSTRAINT "machine_agent_terminals_machineId_pages_id_fk" FOREIGN KEY ("machineId") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "machine_projects_machine_id_idx" ON "machine_projects" USING btree ("machineId");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "machine_projects_machine_id_name_idx" ON "machine_projects" USING btree ("machineId","name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "machine_branches_machine_id_idx" ON "machine_branches" USING btree ("machineId");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "machine_branches_machine_project_branch_idx" ON "machine_branches" USING btree ("machineId","projectName","branchName");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "machine_agent_terminals_machine_id_idx" ON "machine_agent_terminals" USING btree ("machineId");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "machine_agent_terminals_scope_name_idx" ON "machine_agent_terminals" USING btree ("machineId",coalesce("projectName", ''),coalesce("machineBranchId", ''),"name");