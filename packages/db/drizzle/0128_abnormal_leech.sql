ALTER TABLE "pending_invites" ADD COLUMN "custom_role_id" text;--> statement-breakpoint
ALTER TABLE "drive_share_links" ADD COLUMN "custom_role_id" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pending_invites" ADD CONSTRAINT "pending_invites_custom_role_id_drive_roles_id_fk" FOREIGN KEY ("custom_role_id") REFERENCES "public"."drive_roles"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "drive_share_links" ADD CONSTRAINT "drive_share_links_custom_role_id_drive_roles_id_fk" FOREIGN KEY ("custom_role_id") REFERENCES "public"."drive_roles"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pending_invites_custom_role_id_idx" ON "pending_invites" USING btree ("custom_role_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "drive_share_links_custom_role_id_idx" ON "drive_share_links" USING btree ("custom_role_id");