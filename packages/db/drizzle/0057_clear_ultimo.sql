DO $$ BEGIN
 CREATE TYPE "public"."FavoriteItemType" AS ENUM('page', 'drive');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_hotkey_preferences" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"hotkeyId" text NOT NULL,
	"binding" text NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "favorites" ALTER COLUMN "pageId" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "favorites" ADD COLUMN "itemType" "FavoriteItemType" DEFAULT 'page' NOT NULL;--> statement-breakpoint
ALTER TABLE "favorites" ADD COLUMN "driveId" text;--> statement-breakpoint
ALTER TABLE "favorites" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "favorites" ADD COLUMN "createdAt" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_hotkey_preferences" ADD CONSTRAINT "user_hotkey_preferences_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_hotkey_preferences_user_hotkey_idx" ON "user_hotkey_preferences" USING btree ("userId","hotkeyId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_hotkey_preferences_user_idx" ON "user_hotkey_preferences" USING btree ("userId");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "favorites" ADD CONSTRAINT "favorites_driveId_drives_id_fk" FOREIGN KEY ("driveId") REFERENCES "public"."drives"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "favorites_user_id_drive_id_key" ON "favorites" USING btree ("userId","driveId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "favorites_user_id_position_idx" ON "favorites" USING btree ("userId","position");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "favorites_user_page_unique" ON "favorites" ("userId", "pageId") WHERE "pageId" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "favorites_user_drive_unique" ON "favorites" ("userId", "driveId") WHERE "driveId" IS NOT NULL;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "favorites" ADD CONSTRAINT "favorites_item_type_consistency_chk" CHECK (
    (("itemType" = 'page' AND "pageId" IS NOT NULL AND "driveId" IS NULL) OR
     ("itemType" = 'drive' AND "driveId" IS NOT NULL AND "pageId" IS NULL))
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;