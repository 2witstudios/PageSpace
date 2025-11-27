CREATE TABLE IF NOT EXISTS "drive_roles" (
	"id" text PRIMARY KEY NOT NULL,
	"driveId" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"color" text,
	"isDefault" boolean DEFAULT false NOT NULL,
	"permissions" jsonb NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL,
	CONSTRAINT "drive_roles_drive_name_key" UNIQUE("driveId","name")
);
--> statement-breakpoint
ALTER TABLE "drive_members" ADD COLUMN "customRoleId" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "drive_roles" ADD CONSTRAINT "drive_roles_driveId_drives_id_fk" FOREIGN KEY ("driveId") REFERENCES "public"."drives"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "drive_roles_drive_id_idx" ON "drive_roles" USING btree ("driveId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "drive_roles_position_idx" ON "drive_roles" USING btree ("position");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "drive_members" ADD CONSTRAINT "drive_members_customRoleId_drive_roles_id_fk" FOREIGN KEY ("customRoleId") REFERENCES "public"."drive_roles"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "drive_members_custom_role_id_idx" ON "drive_members" USING btree ("customRoleId");