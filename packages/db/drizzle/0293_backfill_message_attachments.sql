-- Backfill the new N:1 attachment tables from the legacy single-attachment
-- columns on channel_messages / direct_messages.
--
-- Hand-written on purpose, and kept in its own file: drizzle-kit cannot emit a
-- data backfill, and 0292 is left as pure unedited generator output so each
-- file has one reviewable provenance story.
--
-- The migration runner keys applied migrations BY HASH of the file text, so any
-- later edit to this file re-runs it on databases that already applied it.
-- Both INSERTs are therefore written to be no-ops on a second pass.
--
-- Skipping messages that ALREADY have an attachment row is what makes that
-- true, and a primary-key conflict target alone would not be enough. A message
-- created by the new application after this migration ran carries BOTH the
-- dual-written legacy columns and a real attachment row at position 0 whose id
-- is a cuid2, not 'legacy_<messageId>'. On replay the id would not collide, but
-- the (messageId, position) unique index would — and ON CONFLICT ("id") does
-- not suppress that, so the migration would abort instead of doing nothing.
--
-- The NOT EXISTS guard is the primary mechanism; the untargeted ON CONFLICT
-- DO NOTHING covers the same ground for any row that slips in between the
-- guard's snapshot and the insert.
--
-- A replay also self-heals, picking up any row an old pod wrote to the legacy
-- columns after this first ran.
--
-- attachmentMeta is copied as-is, including NULL. The backfill must not invent
-- metadata it does not have, and attachment-utils already falls back to the
-- joined files row for mimeType/size. This is also why the attachment tables
-- carry no `fileId IS NOT NULL OR attachmentMeta IS NOT NULL` CHECK: a row
-- backfilled from a fileId with no meta would satisfy such a check only by the
-- fileId, and the ON DELETE SET NULL that follows a hard file delete would then
-- fail it and abort the delete.
INSERT INTO "channel_message_attachments" ("id", "messageId", "fileId", "attachmentMeta", "position", "createdAt")
SELECT 'legacy_' || cm."id", cm."id", cm."fileId", cm."attachmentMeta", 0, cm."createdAt"
FROM "channel_messages" cm
WHERE (cm."fileId" IS NOT NULL OR cm."attachmentMeta" IS NOT NULL)
  AND NOT EXISTS (
    SELECT 1 FROM "channel_message_attachments" a WHERE a."messageId" = cm."id"
  )
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "direct_message_attachments" ("id", "messageId", "fileId", "attachmentMeta", "position", "createdAt")
SELECT 'legacy_' || dm."id", dm."id", dm."fileId", dm."attachmentMeta", 0, dm."createdAt"
FROM "direct_messages" dm
WHERE (dm."fileId" IS NOT NULL OR dm."attachmentMeta" IS NOT NULL)
  AND NOT EXISTS (
    SELECT 1 FROM "direct_message_attachments" a WHERE a."messageId" = dm."id"
  )
ON CONFLICT DO NOTHING;
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
