CREATE TABLE IF NOT EXISTS "machine_projects" (
	"id" text PRIMARY KEY NOT NULL,
	"ownerId" text NOT NULL,
	"terminalId" text NOT NULL,
	"name" text NOT NULL,
	"repoUrl" text NOT NULL,
	"path" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "machine_projects" ADD CONSTRAINT "machine_projects_ownerId_users_id_fk" FOREIGN KEY ("ownerId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "machine_projects" ADD CONSTRAINT "machine_projects_terminalId_pages_id_fk" FOREIGN KEY ("terminalId") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "machine_projects_terminal_id_idx" ON "machine_projects" USING btree ("terminalId");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "machine_projects_terminal_id_name_idx" ON "machine_projects" USING btree ("terminalId","name");