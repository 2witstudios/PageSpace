DO $$ BEGIN
 CREATE TYPE "public"."DriveKind" AS ENUM('STANDARD', 'HOME');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "drives" ADD COLUMN "kind" "DriveKind" DEFAULT 'STANDARD' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "drives_owner_home_unique" ON "drives" USING btree ("ownerId") WHERE "drives"."kind" = 'HOME';