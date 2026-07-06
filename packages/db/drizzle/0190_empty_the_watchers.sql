CREATE TABLE IF NOT EXISTS "machine_branches" (
	"id" text PRIMARY KEY NOT NULL,
	"ownerId" text NOT NULL,
	"terminalId" text NOT NULL,
	"projectName" text NOT NULL,
	"branchName" text NOT NULL,
	"sessionKey" text NOT NULL,
	"sandboxId" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL,
	CONSTRAINT "machine_branches_sessionKey_unique" UNIQUE("sessionKey")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "machine_branches" ADD CONSTRAINT "machine_branches_ownerId_users_id_fk" FOREIGN KEY ("ownerId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "machine_branches" ADD CONSTRAINT "machine_branches_terminalId_pages_id_fk" FOREIGN KEY ("terminalId") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "machine_branches_terminal_id_idx" ON "machine_branches" USING btree ("terminalId");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "machine_branches_terminal_project_branch_idx" ON "machine_branches" USING btree ("terminalId","projectName","branchName");