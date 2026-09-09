-- Content Tags epic, Phase 2 (schema) — ADDITIVE half.
--
-- Reclaims the never-written `tags` table as a DRIVE-SCOPED vocabulary and adds
-- `content_tags`, the assignment table. The destructive half — dropping the
-- equally-dead `page_tags` — is 0271, in its own file: the analyzer in
-- `packages/db/src/migration-sql-analysis.ts` sets `singleDoBlock: false` the
-- moment a second `DO $$` appears anywhere in a file, and `allDropsInsideDoBlock`
-- is derived from it, so putting the guard below and that drop in one file makes
-- the guard assertions fail on a file that is in fact correctly guarded.
--
-- WHY THE PRE-STEP. `tags` has existed since migration 0000 and has never had a
-- writer — the only reference in the whole repo was a cascade delete in the
-- trash route — so it is empty everywhere we can see. But `ADD COLUMN "driveId"
-- text NOT NULL` (and `normalizedKey`, and `updatedAt`, none of which can have a
-- sensible backfill value: a legacy row names no drive) FAILS outright on a
-- populated table, and this migration must not merely ASSUME the table is empty
-- in every deployment we do not control.
--
-- So the guard CLEARS rather than checks. Deliberately NOT `RAISE EXCEPTION`:
-- `packages/db/src/migrate.ts` applies every pending migration in ONE
-- invocation, so a raising pre-flight exits the migrate one-shot nonzero and
-- every service gated on it fails to start — the P1 that
-- `0256_parched_bloodscream.sql`'s header documents at length. The row count
-- reaches the deploy log via RAISE NOTICE before the data goes, in one DO block
-- with the DELETE so psql's ON_ERROR_STOP=off cannot separate them.
--
-- What is being deleted is unreachable data by construction: no code path in any
-- released image has ever INSERTed into `tags`, so any row present is debris
-- from a manual session. The DELETE cascades into `page_tags` (its `tagId` FK is
-- ON DELETE CASCADE), which 0269 drops entirely a moment later.

DO $$
DECLARE legacy_tag_rows bigint := -1;
BEGIN
  IF to_regclass('public.tags') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.tags' INTO legacy_tag_rows;
    RAISE NOTICE 'content-tags phase 2: clearing % unwritable legacy tag rows before the drive-scoped reclaim (-1 means the table was absent)', legacy_tag_rows;
    IF legacy_tag_rows > 0 THEN
      EXECUTE 'DELETE FROM public.tags';
    END IF;
  END IF;
END $$;
--> statement-breakpoint
CREATE TYPE "public"."ContentTagAnchorStatus" AS ENUM('exact', 'shifted', 'fuzzy', 'orphaned');--> statement-breakpoint
CREATE TYPE "public"."ContentTagSource" AS ENUM('user', 'ai', 'system', 'rule');--> statement-breakpoint
CREATE TYPE "public"."ContentTagTargetKind" AS ENUM('page', 'text', 'sheet_cell', 'channel_message', 'ai_message');--> statement-breakpoint
CREATE TABLE "content_tags" (
	"id" text PRIMARY KEY NOT NULL,
	"tagId" text NOT NULL,
	"pageId" text NOT NULL,
	"targetKind" "ContentTagTargetKind" NOT NULL,
	"anchor" jsonb,
	"anchorStatus" "ContentTagAnchorStatus",
	"channelMessageId" text,
	"aiMessageId" text,
	"source" "ContentTagSource" NOT NULL,
	"confidence" real,
	"createdBy" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL,
	CONSTRAINT "content_tags_target_chk" CHECK ((
        ("content_tags"."targetKind" = 'page' AND "content_tags"."anchor" IS NULL AND "content_tags"."anchorStatus" IS NULL AND "content_tags"."channelMessageId" IS NULL AND "content_tags"."aiMessageId" IS NULL)
        OR ("content_tags"."targetKind" = 'text' AND "content_tags"."anchor" IS NOT NULL AND "content_tags"."anchorStatus" IS NOT NULL AND "content_tags"."channelMessageId" IS NULL AND "content_tags"."aiMessageId" IS NULL)
        OR ("content_tags"."targetKind" = 'sheet_cell' AND "content_tags"."anchor" IS NOT NULL AND "content_tags"."anchorStatus" IS NULL AND "content_tags"."channelMessageId" IS NULL AND "content_tags"."aiMessageId" IS NULL)
        OR ("content_tags"."targetKind" = 'channel_message' AND "content_tags"."anchor" IS NULL AND "content_tags"."anchorStatus" IS NULL AND "content_tags"."channelMessageId" IS NOT NULL AND "content_tags"."aiMessageId" IS NULL)
        OR ("content_tags"."targetKind" = 'ai_message' AND "content_tags"."anchor" IS NULL AND "content_tags"."anchorStatus" IS NULL AND "content_tags"."channelMessageId" IS NULL AND "content_tags"."aiMessageId" IS NOT NULL)
      )),
	CONSTRAINT "content_tags_confidence_range_chk" CHECK ("content_tags"."confidence" IS NULL OR ("content_tags"."confidence" >= 0 AND "content_tags"."confidence" <= 1))
);
--> statement-breakpoint
ALTER TABLE "tags" DROP CONSTRAINT "tags_name_unique";--> statement-breakpoint
ALTER TABLE "tags" ALTER COLUMN "color" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tags" ADD COLUMN "driveId" text NOT NULL;--> statement-breakpoint
ALTER TABLE "tags" ADD COLUMN "normalizedKey" text NOT NULL;--> statement-breakpoint
ALTER TABLE "tags" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "tags" ADD COLUMN "createdBy" text;--> statement-breakpoint
ALTER TABLE "tags" ADD COLUMN "createdAt" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "tags" ADD COLUMN "updatedAt" timestamp NOT NULL;--> statement-breakpoint
ALTER TABLE "content_tags" ADD CONSTRAINT "content_tags_tagId_tags_id_fk" FOREIGN KEY ("tagId") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_tags" ADD CONSTRAINT "content_tags_pageId_pages_id_fk" FOREIGN KEY ("pageId") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_tags" ADD CONSTRAINT "content_tags_channelMessageId_channel_messages_id_fk" FOREIGN KEY ("channelMessageId") REFERENCES "public"."channel_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_tags" ADD CONSTRAINT "content_tags_aiMessageId_messages_id_fk" FOREIGN KEY ("aiMessageId") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_tags" ADD CONSTRAINT "content_tags_createdBy_users_id_fk" FOREIGN KEY ("createdBy") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "content_tags_page_id_idx" ON "content_tags" USING btree ("pageId");--> statement-breakpoint
CREATE INDEX "content_tags_tag_id_idx" ON "content_tags" USING btree ("tagId");--> statement-breakpoint
CREATE INDEX "content_tags_created_by_idx" ON "content_tags" USING btree ("createdBy");--> statement-breakpoint
CREATE UNIQUE INDEX "content_tags_page_target_unique" ON "content_tags" USING btree ("pageId","tagId") WHERE "content_tags"."targetKind" = 'page';--> statement-breakpoint
CREATE UNIQUE INDEX "content_tags_channel_message_target_unique" ON "content_tags" USING btree ("channelMessageId","tagId") WHERE "content_tags"."targetKind" = 'channel_message';--> statement-breakpoint
CREATE UNIQUE INDEX "content_tags_ai_message_target_unique" ON "content_tags" USING btree ("aiMessageId","tagId") WHERE "content_tags"."targetKind" = 'ai_message';--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_driveId_drives_id_fk" FOREIGN KEY ("driveId") REFERENCES "public"."drives"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_createdBy_users_id_fk" FOREIGN KEY ("createdBy") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tags_drive_id_idx" ON "tags" USING btree ("driveId");--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_drive_id_normalized_key_key" UNIQUE("driveId","normalizedKey");