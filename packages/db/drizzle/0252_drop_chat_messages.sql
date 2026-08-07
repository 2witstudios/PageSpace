-- ONE MESSAGE TABLE — the contract step (epic "Agent-Session Single Source of
-- Truth", Phase 4 PR 15; docs/2.0-architecture/agent-sessions.md §3a).
--
-- THIS MIGRATION IS IRREVERSIBLE. It DROPs `chat_messages` and
-- `messages."pageId"`. There is no code-level rollback: reverting the
-- deployment restores the readers, not the rows. TAKE A DATABASE SNAPSHOT
-- BEFORE DEPLOYING — see infrastructure/UPGRADE.md, "2026-08 — chat_messages
-- drop".
--
-- Order is load-bearing, and every block is guarded so a re-run is a no-op:
--
--   1. `conversations."agentPageId"` — the page link a `type='client'` (API)
--      thread needs, because its `contextId` is a DRIVE and the transitional
--      `messages."pageId"` it used to answer through is dropped in step 7.
--   2. FINAL SWEEP: copy any `chat_messages` row that has no `messages` twin.
--      This is what protects a tenant/onprem operator who skipped the release
--      carrying `scripts/backfill-unify-messages.ts` — those deployments have
--      no operator to run a script, so the migration has to be the backfill.
--   3. Backfill `agentPageId` from the page the thread's rows named, while
--      that column still exists.
--   4. STALE-TWIN REPAIR: carry across an edit or a soft-delete that landed on
--      the LEGACY leg alone during the dual-write window, before its evidence
--      is dropped.
--   5. COMPLETENESS GUARD: refuse to drop the table if it still holds a row
--      `messages` does not represent.
--   6. `DROP TABLE chat_messages`.
--   7. `ALTER TABLE messages DROP COLUMN "pageId"` and its indexes.
--
-- Steps 2–5 exist because the drop must be safe on a database this repository
-- has never seen. On cloud they are all no-ops: PR 10's dual-write, the
-- backfill script and PR 14's `VALIDATE CONSTRAINT` receipt already proved
-- `messages` is a superset.

--> statement-breakpoint
-- ── 1. The `type='client'` page link ──────────────────────────────────────
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "agentPageId" text;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversations_agentPageId_pages_id_fk'
  ) THEN
    ALTER TABLE "conversations"
      ADD CONSTRAINT "conversations_agentPageId_pages_id_fk"
      FOREIGN KEY ("agentPageId") REFERENCES "public"."pages"("id")
      ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversations_agent_page_id_idx" ON "conversations" USING btree ("agentPageId");--> statement-breakpoint

-- ── 2. FINAL SWEEP ────────────────────────────────────────────────────────
-- Idempotent by construction (`NOT EXISTS` + `ON CONFLICT DO NOTHING`), and
-- the same column mapping the backfill script used. A row whose conversation
-- does not exist CANNOT be copied — `messages."conversationId"` carries a
-- validated, cascading FK — so it is left behind deliberately and named by the
-- guard in step 5 rather than aborting here with an opaque 23503. Migration
-- 0250 already RAISEs on that shape, so reaching it here means 0250 was
-- bypassed.
DO $$
DECLARE
  swept bigint;
BEGIN
  IF to_regclass('public.chat_messages') IS NULL THEN
    RAISE NOTICE '0252: chat_messages is already gone — sweep skipped';
    RETURN;
  END IF;

  INSERT INTO "messages" (
    "id", "conversationId", "userId", "role", "messageType", "content",
    "toolCalls", "toolResults", "createdAt", "isActive", "editedAt",
    "status", "pageId", "sourceAgentId"
  )
  SELECT
    c."id", c."conversationId", c."userId", c."role", c."messageType", c."content",
    c."toolCalls", c."toolResults", c."createdAt", c."isActive", c."editedAt",
    c."status", c."pageId", c."sourceAgentId"
  FROM "chat_messages" c
  WHERE NOT EXISTS (SELECT 1 FROM "messages" m WHERE m."id" = c."id")
    AND EXISTS (SELECT 1 FROM "conversations" cv WHERE cv."id" = c."conversationId")
  ON CONFLICT ("id") DO NOTHING;

  GET DIAGNOSTICS swept = ROW_COUNT;
  IF swept > 0 THEN
    RAISE NOTICE '0252: final sweep carried % straggler chat_messages row(s) into messages', swept;
  ELSE
    RAISE NOTICE '0252: final sweep found nothing to carry — messages was already a superset';
  END IF;
END $$;--> statement-breakpoint

-- ── 3. Backfill the `type='client'` page link ─────────────────────────────
-- FIRST naming row wins, matching the runtime claim
-- (`conversationRepository.stampClientConversationPage` is write-once: the
-- thread's first completion anchors it, and a later request naming a different
-- agent never re-points it). A thread whose rows name a page that no longer
-- exists stays NULL rather than dangling — the FK would refuse it anyway, and
-- a page-less API thread reads exactly as one that has not run a completion.
DO $$
DECLARE
  stamped bigint;
  ambiguous bigint;
  dead_page bigint;
BEGIN
  -- The source column is dropped by step 7, so on a re-run there is nothing
  -- left to derive FROM — and the stamps this block already wrote are still
  -- there. Returning before the UPDATE also stops PL/pgSQL from ever planning
  -- a statement that names a column that no longer exists.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'messages' AND column_name = 'pageId'
  ) THEN
    RAISE NOTICE '0252: messages."pageId" is already gone — client page-link backfill skipped';
    RETURN;
  END IF;

  UPDATE "conversations" cv
     SET "agentPageId" = src."pageId"
    FROM (
      SELECT DISTINCT ON (m."conversationId") m."conversationId", m."pageId"
        FROM "messages" m
        JOIN "conversations" c ON c."id" = m."conversationId"
       WHERE c."type" = 'client'
         AND c."agentPageId" IS NULL
         AND m."pageId" IS NOT NULL
         AND EXISTS (SELECT 1 FROM "pages" p WHERE p."id" = m."pageId")
       ORDER BY m."conversationId", m."createdAt" ASC, m."id" ASC
    ) src
   WHERE cv."id" = src."conversationId"
     AND cv."agentPageId" IS NULL;
  GET DIAGNOSTICS stamped = ROW_COUNT;

  -- Threads whose requests named MORE THAN ONE agent page. Their history load
  -- was already broken before this migration (it returned only the subset
  -- matching the request's page); they now load whole, anchored to the first
  -- agent they spoke to. Reported so the number is on the deploy record.
  SELECT count(*) INTO ambiguous FROM (
    SELECT m."conversationId"
      FROM "messages" m
      JOIN "conversations" c ON c."id" = m."conversationId"
     WHERE c."type" = 'client' AND m."pageId" IS NOT NULL
     GROUP BY m."conversationId"
    HAVING count(DISTINCT m."pageId") > 1
  ) x;

  SELECT count(*) INTO dead_page FROM "conversations" c
   WHERE c."type" = 'client'
     AND c."agentPageId" IS NULL
     AND EXISTS (SELECT 1 FROM "messages" m WHERE m."conversationId" = c."id" AND m."pageId" IS NOT NULL);

  RAISE NOTICE '0252: stamped agentPageId on % client conversation(s)', stamped;
  IF ambiguous > 0 THEN
    RAISE WARNING '0252: % client conversation(s) named more than one agent page; anchored to the earliest', ambiguous;
  END IF;
  IF dead_page > 0 THEN
    RAISE WARNING '0252: % client conversation(s) named only deleted page(s) and stay page-less', dead_page;
  END IF;
END $$;--> statement-breakpoint

-- ── 4. STALE-TWIN REPAIR ──────────────────────────────────────────────────
-- The completeness guard below asks only whether a ROW is represented. That is
-- the right question after the PR 14 freeze, but it is blind to a row that HAS
-- a twin whose twin is STALE — and the drop destroys the evidence.
--
-- HOW A TWIN GOES STALE. Not after the freeze; DURING PR 10's dual-write
-- rolling deploy. A pod that has not yet picked up the dual-write serves an
-- edit or a soft-delete and writes it to `chat_messages` ALONE. The documented
-- `UNIFIED_MESSAGES_DUAL_WRITE=off` kill switch makes that window
-- operator-controllable and arbitrarily long. Nothing downstream repairs it:
-- `scripts/backfill-unify-messages.ts` only INSERTs rows that are missing and
-- never updates one it already copied, the sweep in step 2 skips any row that
-- already has a twin, and the retired reconcile cron compared only row counts
-- and `MAX("createdAt")` — neither of which moves when a row is edited in
-- place. So the divergence survives all the way to here, and dropping the
-- table silently REVERTS the edit and RESURRECTS the soft-deleted message.
--
-- WHY THESE TWO SHAPES PROVE A LOST WRITE. Since PR 14 the legacy leg is
-- IMMUTABLE — nothing writes it. So the legacy leg can only be ahead of the
-- unified leg if the write predates the freeze and never crossed over:
--   * `chat_messages."editedAt"` set, and the unified row's is NULL or OLDER
--     → an edit the unified leg never received;
--   * `chat_messages."isActive" = false` while the unified row is still true
--     → a soft-delete the unified leg never received. Resurrecting a
--       tombstoned message is the worse of the two failures.
-- The REVERSE direction (unified newer) is the normal, healthy state and is
-- deliberately left alone — see the guard's note below.
--
-- REPAIR, NOT RAISE. The direction here is unambiguous: there is exactly one
-- newer value and it is about to be deleted. A RAISE would block the deploy on
-- a condition the operator has no way to resolve by hand — the remedy would be
-- "hand-merge two message tables", with the correct answer already computable
-- right here. Refusing to deploy is only the right call when a human has to
-- CHOOSE (that is the guard below, where a row cannot be represented at all).
--
-- Each field is repaired only on the condition that proves IT stale, so a row
-- carrying a legacy soft-delete AND a legitimately newer unified edit keeps
-- the edit and gains the deletion. Idempotent: after the UPDATE neither
-- predicate can still hold, so a re-run matches nothing.
DO $$
DECLARE
  repaired bigint;
BEGIN
  IF to_regclass('public.chat_messages') IS NULL THEN
    RAISE NOTICE '0252: chat_messages is already gone — stale-twin repair skipped';
    RETURN;
  END IF;

  UPDATE "messages" m
     SET "content" = CASE
           WHEN c."editedAt" IS NOT NULL AND (m."editedAt" IS NULL OR c."editedAt" > m."editedAt")
           THEN c."content" ELSE m."content" END,
         "editedAt" = CASE
           WHEN c."editedAt" IS NOT NULL AND (m."editedAt" IS NULL OR c."editedAt" > m."editedAt")
           THEN c."editedAt" ELSE m."editedAt" END,
         "isActive" = CASE
           WHEN c."isActive" = false AND m."isActive" = true
           THEN false ELSE m."isActive" END
    FROM "chat_messages" c
   WHERE m."id" = c."id"
     AND (
       (c."editedAt" IS NOT NULL AND (m."editedAt" IS NULL OR c."editedAt" > m."editedAt"))
       OR (c."isActive" = false AND m."isActive" = true)
     );
  GET DIAGNOSTICS repaired = ROW_COUNT;

  IF repaired > 0 THEN
    RAISE WARNING '0252: repaired % stale unified row(s) whose edit or soft-delete had landed only on chat_messages (dual-write window loss)', repaired;
  ELSE
    RAISE NOTICE '0252: no stale unified rows — every legacy edit/soft-delete had already crossed over';
  END IF;
END $$;--> statement-breakpoint

-- ── 5. COMPLETENESS GUARD ─────────────────────────────────────────────────
-- The last chance to notice that dropping the table would lose something.
--
-- A "twin" is a `messages` row with the SAME id, in the SAME conversation,
-- with the SAME role. It is deliberately NOT a content comparison, and that is
-- not laziness: since PR 14 froze the legacy leg, every edit, soft-delete,
-- undo tombstone and interrupted-stream materialisation has landed on
-- `messages` ALONE. Divergent content is therefore the NORMAL state of a
-- healthy database — the unified row is the newer truth, and has been the only
-- row anyone reads since PR 12 — so a content-equality guard would refuse to
-- deploy on every database that has served an edit. What must not be lost is a
-- ROW, and that is what this checks. The narrow, PROVABLY-backwards subset of
-- divergence is not left to this guard at all: step 4 above has already
-- repaired it.
DO $$
DECLARE
  untwinned bigint;
  orphaned bigint;
  sample text;
BEGIN
  IF to_regclass('public.chat_messages') IS NULL THEN
    RAISE NOTICE '0252: chat_messages is already gone — completeness guard skipped';
    RETURN;
  END IF;

  SELECT count(*) INTO untwinned
    FROM "chat_messages" c
   WHERE NOT EXISTS (
     SELECT 1 FROM "messages" m
      WHERE m."id" = c."id"
        AND m."conversationId" = c."conversationId"
        AND m."role" = c."role"
   );

  IF untwinned > 0 THEN
    SELECT count(*) INTO orphaned
      FROM "chat_messages" c
     WHERE NOT EXISTS (SELECT 1 FROM "conversations" cv WHERE cv."id" = c."conversationId");

    SELECT string_agg(x."id", ', ') INTO sample FROM (
      SELECT c."id"
        FROM "chat_messages" c
       WHERE NOT EXISTS (
         SELECT 1 FROM "messages" m
          WHERE m."id" = c."id"
            AND m."conversationId" = c."conversationId"
            AND m."role" = c."role"
       )
       ORDER BY c."createdAt", c."id"
       LIMIT 50
    ) x;

    RAISE EXCEPTION
      'chat_messages still holds % row(s) that "messages" does not represent — refusing to DROP the table. % of them name a conversation that does not exist (those cannot be copied: messages."conversationId" is a validated FK, and migration 0250 RAISEs on exactly that shape). First up to 50 ids: %',
      untwinned, orphaned, coalesce(sample, '(none)')
      USING HINT = 'Repair is a human decision, not a migration''s. Run scripts/backfill-unify-messages.ts from a release that still has it, or synthesise the missing conversations rows, then re-run this migration. Do NOT drop the table with rows outstanding.';
  END IF;

  RAISE NOTICE '0252: completeness guard passed — every chat_messages row has a messages twin';
END $$;--> statement-breakpoint

-- ── 6. THE DROP ───────────────────────────────────────────────────────────
DROP TABLE IF EXISTS "chat_messages" CASCADE;--> statement-breakpoint

-- ── 7. The transitional column goes with it ───────────────────────────────
-- A message's page is its CONVERSATION's page now: `contextId` for
-- `type='page'`, `agentPageId` for `type='client'`
-- (apps/web/src/lib/repositories/unified-message-scope.ts is the one place
-- that derivation is written down).
DROP INDEX IF EXISTS "messages_page_id_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "messages_page_id_is_active_created_at_idx";--> statement-breakpoint
ALTER TABLE "messages" DROP COLUMN IF EXISTS "pageId";
