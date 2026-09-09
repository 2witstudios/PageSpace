-- Backfill the new N:1 attachment tables from the legacy single-attachment
-- columns on channel_messages / direct_messages.
--
-- Hand-written on purpose, and kept in its own file: drizzle-kit cannot emit a
-- data backfill, and 0291 is left as pure unedited generator output so each
-- file has one reviewable provenance story.
--
-- The migration runner keys applied migrations BY HASH of the file text, so any
-- later edit to this file re-runs it on databases that already applied it.
-- Both INSERTs are therefore safe on a second pass: the id is derived from the
-- message id ('legacy_' || id — at most one legacy attachment per message) so a
-- replay collides on the primary key and ON CONFLICT DO NOTHING makes it a
-- no-op instead of inserting a duplicate. A replay also self-heals, picking up
-- any row an old pod wrote to the legacy columns after this first ran.
--
-- attachmentMeta is copied as-is, including NULL: the not_empty CHECK only
-- requires one of (fileId, attachmentMeta), and attachment-utils already falls
-- back to the joined files row for mimeType/size.
INSERT INTO "channel_message_attachments" ("id", "messageId", "fileId", "attachmentMeta", "position", "createdAt")
SELECT 'legacy_' || cm."id", cm."id", cm."fileId", cm."attachmentMeta", 0, cm."createdAt"
FROM "channel_messages" cm
WHERE cm."fileId" IS NOT NULL OR cm."attachmentMeta" IS NOT NULL
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "direct_message_attachments" ("id", "messageId", "fileId", "attachmentMeta", "position", "createdAt")
SELECT 'legacy_' || dm."id", dm."id", dm."fileId", dm."attachmentMeta", 0, dm."createdAt"
FROM "direct_messages" dm
WHERE dm."fileId" IS NOT NULL OR dm."attachmentMeta" IS NOT NULL
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
-- Fail the migration rather than ship a silently partial backfill. The runner
-- wraps each file in one transaction, so this rolls the whole file back.
-- This matters more than it looks: a legacy row with no attachment row is the
-- exact input to the file-reaper chain (a DM purge would drop the
-- file_conversations link, and the orphaned-file cron would then delete the
-- blob from S3).
DO $$
DECLARE missing bigint;
BEGIN
  SELECT
    (SELECT count(*) FROM "channel_messages" cm
      WHERE (cm."fileId" IS NOT NULL OR cm."attachmentMeta" IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM "channel_message_attachments" a WHERE a."messageId" = cm."id"))
  + (SELECT count(*) FROM "direct_messages" dm
      WHERE (dm."fileId" IS NOT NULL OR dm."attachmentMeta" IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM "direct_message_attachments" a WHERE a."messageId" = dm."id"))
  INTO missing;
  IF missing > 0 THEN
    RAISE EXCEPTION 'message attachment backfill incomplete: % rows unmigrated', missing;
  END IF;
END $$;
