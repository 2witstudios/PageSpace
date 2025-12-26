DO $$ BEGIN
 CREATE TYPE "public"."activity_change_group_type" AS ENUM('user', 'ai', 'automation', 'system');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."drive_backup_source" AS ENUM('manual', 'scheduled', 'pre_restore', 'system');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."drive_backup_status" AS ENUM('pending', 'ready', 'failed');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."page_version_source" AS ENUM('manual', 'auto', 'pre_ai', 'pre_restore', 'restore', 'system');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "drive_backup_files" (
	"backupId" text NOT NULL,
	"fileId" text NOT NULL,
	"storagePath" text,
	"sizeBytes" integer,
	"mimeType" text,
	"checksumVersion" integer,
	CONSTRAINT "drive_backup_files_backupId_fileId_pk" PRIMARY KEY("backupId","fileId")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "drive_backup_members" (
	"backupId" text NOT NULL,
	"userId" text NOT NULL,
	"role" text,
	"customRoleId" text,
	"invitedBy" text,
	"invitedAt" timestamp,
	"acceptedAt" timestamp,
	CONSTRAINT "drive_backup_members_backupId_userId_pk" PRIMARY KEY("backupId","userId")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "drive_backup_pages" (
	"backupId" text NOT NULL,
	"pageId" text NOT NULL,
	"pageVersionId" text,
	"title" text,
	"type" text,
	"parentId" text,
	"originalParentId" text,
	"position" real,
	"isTrashed" boolean DEFAULT false NOT NULL,
	"trashedAt" timestamp,
	CONSTRAINT "drive_backup_pages_backupId_pageId_pk" PRIMARY KEY("backupId","pageId")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "drive_backup_permissions" (
	"backupId" text NOT NULL,
	"pageId" text NOT NULL,
	"userId" text NOT NULL,
	"canView" boolean DEFAULT true NOT NULL,
	"canEdit" boolean DEFAULT false NOT NULL,
	"canShare" boolean DEFAULT false NOT NULL,
	"canDelete" boolean DEFAULT false NOT NULL,
	"grantedBy" text,
	"note" text,
	"expiresAt" timestamp,
	CONSTRAINT "drive_backup_permissions_backupId_pageId_userId_pk" PRIMARY KEY("backupId","pageId","userId")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "drive_backup_roles" (
	"backupId" text NOT NULL,
	"roleId" text NOT NULL,
	"name" text,
	"description" text,
	"color" text,
	"isDefault" boolean DEFAULT false NOT NULL,
	"permissions" jsonb,
	"position" integer,
	CONSTRAINT "drive_backup_roles_backupId_roleId_pk" PRIMARY KEY("backupId","roleId")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "drive_backups" (
	"id" text PRIMARY KEY NOT NULL,
	"driveId" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"createdBy" text,
	"source" "drive_backup_source" DEFAULT 'manual' NOT NULL,
	"status" "drive_backup_status" DEFAULT 'pending' NOT NULL,
	"label" text,
	"reason" text,
	"changeGroupId" text,
	"changeGroupType" "activity_change_group_type",
	"isPinned" boolean DEFAULT false NOT NULL,
	"expiresAt" timestamp,
	"metadata" jsonb,
	"completedAt" timestamp,
	"failedAt" timestamp,
	"failureReason" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "page_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"pageId" text NOT NULL,
	"driveId" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"createdBy" text,
	"source" "page_version_source" DEFAULT 'auto' NOT NULL,
	"label" text,
	"reason" text,
	"changeGroupId" text,
	"changeGroupType" "activity_change_group_type",
	"contentRef" text,
	"contentFormat" "content_format",
	"contentSize" integer,
	"stateHash" text,
	"pageRevision" integer DEFAULT 0 NOT NULL,
	"isPinned" boolean DEFAULT false NOT NULL,
	"expiresAt" timestamp,
	"metadata" jsonb
);
--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "stateHash" text;--> statement-breakpoint
ALTER TABLE "activity_logs" ADD COLUMN "contentRef" text;--> statement-breakpoint
ALTER TABLE "activity_logs" ADD COLUMN "contentSize" integer;--> statement-breakpoint
ALTER TABLE "activity_logs" ADD COLUMN "streamId" text;--> statement-breakpoint
ALTER TABLE "activity_logs" ADD COLUMN "streamSeq" integer;--> statement-breakpoint
ALTER TABLE "activity_logs" ADD COLUMN "changeGroupId" text;--> statement-breakpoint
ALTER TABLE "activity_logs" ADD COLUMN "changeGroupType" "activity_change_group_type";--> statement-breakpoint
ALTER TABLE "activity_logs" ADD COLUMN "stateHashBefore" text;--> statement-breakpoint
ALTER TABLE "activity_logs" ADD COLUMN "stateHashAfter" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "drive_backup_files" ADD CONSTRAINT "drive_backup_files_backupId_drive_backups_id_fk" FOREIGN KEY ("backupId") REFERENCES "public"."drive_backups"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "drive_backup_members" ADD CONSTRAINT "drive_backup_members_backupId_drive_backups_id_fk" FOREIGN KEY ("backupId") REFERENCES "public"."drive_backups"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "drive_backup_pages" ADD CONSTRAINT "drive_backup_pages_backupId_drive_backups_id_fk" FOREIGN KEY ("backupId") REFERENCES "public"."drive_backups"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "drive_backup_pages" ADD CONSTRAINT "drive_backup_pages_pageVersionId_page_versions_id_fk" FOREIGN KEY ("pageVersionId") REFERENCES "public"."page_versions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "drive_backup_permissions" ADD CONSTRAINT "drive_backup_permissions_backupId_drive_backups_id_fk" FOREIGN KEY ("backupId") REFERENCES "public"."drive_backups"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "drive_backup_roles" ADD CONSTRAINT "drive_backup_roles_backupId_drive_backups_id_fk" FOREIGN KEY ("backupId") REFERENCES "public"."drive_backups"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "drive_backups" ADD CONSTRAINT "drive_backups_driveId_drives_id_fk" FOREIGN KEY ("driveId") REFERENCES "public"."drives"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "drive_backups" ADD CONSTRAINT "drive_backups_createdBy_users_id_fk" FOREIGN KEY ("createdBy") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "page_versions" ADD CONSTRAINT "page_versions_pageId_pages_id_fk" FOREIGN KEY ("pageId") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "page_versions" ADD CONSTRAINT "page_versions_driveId_drives_id_fk" FOREIGN KEY ("driveId") REFERENCES "public"."drives"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "page_versions" ADD CONSTRAINT "page_versions_createdBy_users_id_fk" FOREIGN KEY ("createdBy") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "drive_backup_files_backup_idx" ON "drive_backup_files" USING btree ("backupId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "drive_backup_members_backup_idx" ON "drive_backup_members" USING btree ("backupId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "drive_backup_pages_backup_idx" ON "drive_backup_pages" USING btree ("backupId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "drive_backup_permissions_backup_idx" ON "drive_backup_permissions" USING btree ("backupId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "drive_backup_roles_backup_idx" ON "drive_backup_roles" USING btree ("backupId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "drive_backups_drive_created_at_idx" ON "drive_backups" USING btree ("driveId","createdAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "drive_backups_status_idx" ON "drive_backups" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "page_versions_page_created_at_idx" ON "page_versions" USING btree ("pageId","createdAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "page_versions_drive_created_at_idx" ON "page_versions" USING btree ("driveId","createdAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "page_versions_pinned_idx" ON "page_versions" USING btree ("isPinned");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_activity_logs_stream" ON "activity_logs" USING btree ("streamId","streamSeq") WHERE "activity_logs"."streamId" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_activity_logs_change_group" ON "activity_logs" USING btree ("changeGroupId") WHERE "activity_logs"."changeGroupId" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_content_size_limit" CHECK ("contentSize" IS NULL OR "contentSize" <= 1048576);
--> statement-breakpoint
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_stream_pair" CHECK (("streamId" IS NULL) = ("streamSeq" IS NULL));
