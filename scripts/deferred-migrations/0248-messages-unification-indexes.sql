-- ════════════════════════════════════════════════════════════════════════════
-- DEFERRED — the LARGE-CORPUS half of migration 0248's index gate
-- ════════════════════════════════════════════════════════════════════════════
--
-- Epic "Agent-Session Single Source of Truth", Phase 4 PR 9 (expand step of
-- merging `chat_messages` into `messages`).
--
-- Migration 0248 adds `messages.pageId` and needs two page-scoped indexes to
-- reach parity with `chat_messages`'s access paths before the backfill (Phase 4
-- PR 10) copies the whole legacy corpus into `messages`. The migration builds
-- them ITSELF when `chat_messages` is below its 5M-row gate — which covers
-- every tenant/onprem database, where no operator exists to run scripts.
--
-- Above the gate it skips them and emits:
--
--   NOTICE: messages unification (0248): parity indexes DEFERRED ...
--
-- ...which means THIS FILE. Unlike the other file in this directory, it carries
-- no abort guard: it is meant to be run, and running it twice is a no-op.
--
-- WHY IT CANNOT LIVE IN THE MIGRATION: `CREATE INDEX CONCURRENTLY` cannot run
-- inside a transaction block, and every migration statement runs inside one
-- (packages/db/src/migration-runner.ts commits per migration). A plain
-- `CREATE INDEX` on a table with tens of millions of rows holds a write lock
-- for the whole build — an outage on the page-chat write path.
--
-- WHEN: after 0248 has been applied, and BEFORE the PR 10 backfill starts
-- writing legacy rows into `messages`. Running it late is not harmful, only
-- slower (the build then has to cover the copied rows too).
--
-- HOW (cloud, psql against the app database; NOT inside a transaction):
--   psql "$DATABASE_URL" -f scripts/deferred-migrations/0248-messages-unification-indexes.sql
--
-- AFTERWARDS: verify both are valid — a CONCURRENTLY build that is interrupted
-- leaves an INVALID index behind, which the planner ignores and which must be
-- dropped and rebuilt:
--
--   SELECT c.relname, i.indisvalid
--   FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
--   WHERE c.relname IN ('messages_page_id_idx',
--                       'messages_page_id_is_active_created_at_idx');
--
-- The index names and definitions are the ones declared in
-- packages/db/src/schema/conversations.ts (`messages` table) — keep all three
-- in sync: the schema declaration, the migration's inline branch, and this
-- file.

-- Page-scoped lookups (trash/page listings, per-page sweeps) — the counterpart
-- of chat_messages_page_id_idx.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "messages_page_id_idx"
  ON "messages" USING btree ("pageId");

-- Page history loads — the counterpart of
-- chat_messages_page_id_is_active_created_at_idx.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "messages_page_id_is_active_created_at_idx"
  ON "messages" USING btree ("pageId", "isActive", "createdAt");
