CREATE TABLE IF NOT EXISTS "file_pages" (
	"fileId" text NOT NULL,
	"pageId" text NOT NULL,
	"linkedBy" text,
	"linkedAt" timestamp DEFAULT now() NOT NULL,
	"linkSource" text,
	CONSTRAINT "file_pages_fileId_pageId_pk" PRIMARY KEY("fileId","pageId"),
	CONSTRAINT "file_pages_page_id_key" UNIQUE("pageId")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "files" (
	"id" text PRIMARY KEY NOT NULL,
	"driveId" text NOT NULL,
	"sizeBytes" bigint NOT NULL,
	"mimeType" text,
	"storagePath" text,
	"checksumVersion" integer DEFAULT 1 NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"createdBy" text,
	"lastAccessedAt" timestamp
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "file_pages" ADD CONSTRAINT "file_pages_fileId_files_id_fk" FOREIGN KEY ("fileId") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "file_pages" ADD CONSTRAINT "file_pages_pageId_pages_id_fk" FOREIGN KEY ("pageId") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "file_pages" ADD CONSTRAINT "file_pages_linkedBy_users_id_fk" FOREIGN KEY ("linkedBy") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "files" ADD CONSTRAINT "files_driveId_drives_id_fk" FOREIGN KEY ("driveId") REFERENCES "public"."drives"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "files" ADD CONSTRAINT "files_createdBy_users_id_fk" FOREIGN KEY ("createdBy") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "file_pages_file_id_idx" ON "file_pages" USING btree ("fileId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "file_pages_page_id_idx" ON "file_pages" USING btree ("pageId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "files_drive_id_idx" ON "files" USING btree ("driveId");