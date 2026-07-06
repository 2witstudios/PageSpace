CREATE TABLE IF NOT EXISTS "machine_agent_terminals" (
	"id" text PRIMARY KEY NOT NULL,
	"ownerId" text NOT NULL,
	"machineBranchId" text NOT NULL,
	"name" text NOT NULL,
	"agentType" text NOT NULL,
	"streamSessionId" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "machine_agent_terminals" ADD CONSTRAINT "machine_agent_terminals_ownerId_users_id_fk" FOREIGN KEY ("ownerId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "machine_agent_terminals" ADD CONSTRAINT "machine_agent_terminals_machineBranchId_machine_branches_id_fk" FOREIGN KEY ("machineBranchId") REFERENCES "public"."machine_branches"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "machine_agent_terminals_branch_id_idx" ON "machine_agent_terminals" USING btree ("machineBranchId");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "machine_agent_terminals_branch_name_idx" ON "machine_agent_terminals" USING btree ("machineBranchId","name");