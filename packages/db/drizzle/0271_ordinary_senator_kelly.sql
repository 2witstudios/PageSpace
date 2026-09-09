-- Content Tags epic, Phase 2 (schema) — DESTRUCTIVE half.
--
-- Drops `page_tags`. The table was created by migration 0000 and has never had a
-- write path: the only reference anywhere in the repo was a cascade delete in
-- `apps/web/src/app/api/trash/[pageId]/route.ts`, deleting rows nothing ever
-- inserted. Its replacement, `content_tags` (0270), covers the same ground and
-- more — one tag can attach to a page many times at different targets, which a
-- composite-PK join table cannot express — and its own `pageId` cascade covers
-- the trash route's delete, which is why that statement is gone rather than
-- retargeted.
--
-- THIS MIGRATION IS IRREVERSIBLE. Reverting the deployment restores the schema
-- declaration, not the rows.
--
-- SEPARATE FILE from 0270 on purpose. `packages/db/src/migration-sql-analysis.ts`
-- sets `singleDoBlock: false` when a second `DO $$` appears ANYWHERE in a file,
-- and `allDropsInsideDoBlock` is derived from it — so 0270's guarded pre-step
-- and this guarded drop cannot share a file without the analyzer's own
-- assertions failing on correct SQL. Two files in one PR is safe here because
-- nothing has to run BETWEEN them; the rule against staging two migrations is
-- about needing a script in the gap.
--
-- The DROP is generated DDL (`DROP TABLE "page_tags" CASCADE;`) moved verbatim
-- inside the guard; nothing about the statement itself is hand-written. The
-- RAISE NOTICE records the row count in the deploy log before the data is gone,
-- and it shares ONE DO block with the drop because psql's default
-- ON_ERROR_STOP=off reports a failed statement and CONTINUES — a count taken as
-- its own statement would prove nothing about what followed it. Identifiers stay
-- double-quoted: the analyzer's regexes only match quoted names.

DO $$
DECLARE legacy_row_count bigint := -1;
BEGIN
  IF to_regclass('public.page_tags') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.page_tags' INTO legacy_row_count;
  END IF;
  RAISE NOTICE 'content-tags phase 2: dropping the dead page_tags table (rows = %, -1 means already absent)', legacy_row_count;

  DROP TABLE IF EXISTS "public"."page_tags" CASCADE;
END $$;
