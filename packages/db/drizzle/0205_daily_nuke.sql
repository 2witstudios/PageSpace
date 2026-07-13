CREATE TABLE IF NOT EXISTS "machine_workspaces" (
	"id" text NOT NULL,
	"ownerId" text NOT NULL,
	"machineId" text NOT NULL,
	"scope" text NOT NULL,
	"projectName" text,
	"branchName" text,
	"name" text NOT NULL,
	"layout" jsonb NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL,
	CONSTRAINT "machine_workspaces_machineId_id_pk" PRIMARY KEY("machineId","id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "machine_workspace_bootstraps" (
	"machineId" text PRIMARY KEY NOT NULL,
	"bootstrappedByUserId" text,
	"bootstrappedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "machine_workspaces" ADD CONSTRAINT "machine_workspaces_ownerId_users_id_fk" FOREIGN KEY ("ownerId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "machine_workspaces" ADD CONSTRAINT "machine_workspaces_machineId_pages_id_fk" FOREIGN KEY ("machineId") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "machine_workspace_bootstraps" ADD CONSTRAINT "machine_workspace_bootstraps_machineId_pages_id_fk" FOREIGN KEY ("machineId") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "machine_workspace_bootstraps" ADD CONSTRAINT "machine_workspace_bootstraps_bootstrappedByUserId_users_id_fk" FOREIGN KEY ("bootstrappedByUserId") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "machine_workspaces_machine_id_idx" ON "machine_workspaces" USING btree ("machineId");