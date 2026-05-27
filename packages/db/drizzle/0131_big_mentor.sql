ALTER TABLE "mcp_token_drives" ADD COLUMN "role" "MemberRole" DEFAULT 'MEMBER' NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_token_drives" ADD COLUMN "customRoleId" text;--> statement-breakpoint
ALTER TABLE "mcp_token_drives" ADD COLUMN "addedBy" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mcp_token_drives" ADD CONSTRAINT "mcp_token_drives_customRoleId_drive_roles_id_fk" FOREIGN KEY ("customRoleId") REFERENCES "public"."drive_roles"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mcp_token_drives" ADD CONSTRAINT "mcp_token_drives_addedBy_users_id_fk" FOREIGN KEY ("addedBy") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
