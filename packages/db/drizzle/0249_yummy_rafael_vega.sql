ALTER TABLE "messages" ALTER COLUMN "userId" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "pageId" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "sourceAgentId" text;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sourceAgentId_pages_id_fk" FOREIGN KEY ("sourceAgentId") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- ══════════════════════════════════════════════════════════════════════════
-- Hand-appended below (repo convention — precedent 0247_vengeful_veda.sql,
-- 0225_blushing_tattoo.sql, 0222_wooden_puck.sql, 0116_colossal_tattoo.sql:
-- idempotent DO $$ blocks appended to a freshly generated migration; applied
-- migrations are never edited).
--
-- Epic "Agent-Session Single Source of Truth", Phase 4 PR 9 — the EXPAND step
-- of merging `chat_messages` INTO `messages` (docs/2.0-architecture/
-- agent-sessions.md; plan D6). Everything above this line is the drizzle
-- schema diff: three widening column changes plus the `sourceAgentId` FK, all
-- instant metadata-only operations. Everything below is not schema-diffable:
--
--   1. PRE-AUDIT      — the `conversationId → pageId` 1:1 assumption the whole
--                       merge rests on, asserted before anything is written.
--   2. SYNTHESIS      — mint the missing `conversations` rows for orphan
--                       `chat_messages.conversationId`s (ownership rule below).
--   3. FK (NOT VALID) — `chat_messages.conversationId` finally gets a real
--                       parent. New writes are checked; the existing corpus is
--                       NOT scanned. `VALIDATE CONSTRAINT` is a later PR.
--   4. INDEX GATE     — parity indexes on `messages`, built inline when the
--                       corpus is small enough, otherwise deferred to
--                       CREATE INDEX CONCURRENTLY (see the gate's comment).
--
-- No reader or writer changes ship with this migration: nothing writes
-- `messages.pageId`/`sourceAgentId` yet, and nothing reads the synthesized
-- rows differently from any other `conversations` row. This is expand-only,
-- and every statement is re-runnable.
-- ══════════════════════════════════════════════════════════════════════════

-- ── 1. PRE-AUDIT ──────────────────────────────────────────────────────────
-- The merge derives a page conversation's page from `conversations.contextId`
-- (`type='page' ⇒ contextId IS the pageId`), which is only meaningful if a
-- `chat_messages.conversationId` names EXACTLY ONE page. Nothing has ever
-- enforced that — `conversationId` is client-suppliable and self-minting — so
-- it is asserted here, before a single row is written.
--
-- Failing loudly on real data is the CORRECT outcome: a PAGE conversation whose
-- messages straddle two pages cannot be synthesized into one row without
-- guessing which page it belongs to, and a wrong guess silently relocates
-- someone's history. The fix is a deliberate split (a data repair, reviewed on
-- its own), not a default inside a migration.
--
-- SCOPE — `type='client'` threads are EXCLUDED from the abort, deliberately.
-- An API thread is anchored to a DRIVE, not a page: its `contextId` is the
-- drive id, so the "contextId must represent the page" premise above simply
-- does not apply to it. Addressing more than one agent page over a thread's
-- life is a DOCUMENTED, SUPPORTED shape (docs/2.0-architecture/
-- agent-sessions.md), and 0253 already handles it gracefully downstream —
-- it derives `conversations."agentPageId"` from the EARLIEST naming row and
-- merely warns ('% client conversation(s) named more than one agent page;
-- anchored to the earliest'). Aborting here would make the upgrade impossible
-- for any deployment that ever served a two-agent API thread, to protect an
-- invariant that thread never had to satisfy. These are still surfaced by the
-- non-fatal audit immediately below (they trip its `c."type" <> 'page'` arm).
DO $$
DECLARE
  offender_count bigint;
  offender_sample text;
BEGIN
  SELECT count(*) INTO offender_count
  FROM (
    SELECT cm."conversationId"
    FROM "chat_messages" cm
    WHERE NOT EXISTS (
      SELECT 1 FROM "conversations" c
       WHERE c."id" = cm."conversationId" AND c."type" = 'client'
    )
    GROUP BY cm."conversationId"
    HAVING count(DISTINCT cm."pageId") > 1
  ) straddling;

  IF offender_count > 0 THEN
    SELECT string_agg(c, ', ') INTO offender_sample
    FROM (
      SELECT cm."conversationId" AS c
      FROM "chat_messages" cm
      WHERE NOT EXISTS (
        SELECT 1 FROM "conversations" cv
         WHERE cv."id" = cm."conversationId" AND cv."type" = 'client'
      )
      GROUP BY cm."conversationId"
      HAVING count(DISTINCT cm."pageId") > 1
      ORDER BY 1
      LIMIT 50
    ) sample;

    RAISE EXCEPTION 'messages unification (0249) pre-audit failed: % chat_messages conversationId(s) span more than one pageId, so conversations.contextId cannot represent them. Split them deliberately, then re-run. First (up to 50): %',
      offender_count, offender_sample;
  END IF;

  -- Not fatal, but the same class of drift and the reader cutover's other
  -- blind spot: a `chat_messages.conversationId` that ALREADY has a
  -- `conversations` row which disagrees with the messages about the page (or
  -- is not a page conversation at all). Synthesis skips these by definition —
  -- the row exists — so they are reported instead, for a follow-up repair.
  SELECT count(*) INTO offender_count
  FROM (
    SELECT cm."conversationId"
    FROM "chat_messages" cm
    JOIN "conversations" c ON c."id" = cm."conversationId"
    WHERE c."type" <> 'page' OR c."contextId" IS DISTINCT FROM cm."pageId"
    GROUP BY cm."conversationId"
  ) mismatched;

  IF offender_count > 0 THEN
    RAISE NOTICE 'messages unification (0249): % existing conversations row(s) disagree with their chat_messages about the page (type <> page, or contextId <> pageId). Not repaired here — the reader cutover derives the page from contextId, so these need a follow-up data repair.', offender_count;
  END IF;
END $$;--> statement-breakpoint

-- ── 2. ORPHAN CONVERSATION SYNTHESIS ──────────────────────────────────────
-- `chat_messages.conversationId` mints itself and has never had a parent row
-- requirement, so a large share of page-chat conversations exist only as a
-- group of messages. They must become real `conversations` rows before step 3
-- can add the FK, and before the backfill can copy them into `messages`
-- (whose `conversationId` FK is validated and cascading).
--
-- OWNERSHIP (user-locked decision 4 of the epic plan; ladder, first hit wins):
--   1. the EARLIEST user-role message's non-null `userId` — the strongest
--      evidence that exists: a human said something in this thread;
--   2. else the page's creator (`pages.createdBy`);
--   3. else the page's drive owner (`drives.ownerId`);
--   4. else SKIP the conversation and report the count (see the notice below).
--
-- QUARANTINE (`isActive=false`) is orthogonal to that ladder, and this is the
-- one place this migration departs from the letter of decision 4 ("unresolvable
-- → mint quarantined"). It cannot be implemented that way: `conversations.userId`
-- is NOT NULL and FK'd to `users`, so a row with no resolvable owner cannot be
-- minted AT ALL — quarantined or otherwise. Tier 4 is therefore a skip, and
-- quarantine is applied to the case that genuinely needs it:
--
--   a conversation whose messages are ALL already soft-deleted.
--
-- Minting those `isActive=true` would resurrect tombstoned history into a live,
-- claimable row — the exact opposite of what `softDeleteConversation` does
-- (it tombstones the conversation row and its messages TOGETHER). Quarantined
-- rows are unclaimable: `claimConversation`'s WHERE carries
-- `eq(conversations.isActive, true)` (apps/web/src/lib/repositories/
-- conversation-repository.ts, the `claimConversation` UPDATE), so a quarantined
-- thread can never be bound into anybody's session.
--
-- Quarantine is applied NARROWLY for a concrete reason: `isActive=false` is the
-- retention engine's purge signal (`cleanupSoftDeletedChatRecords`,
-- `purgeInactiveConversations`), and step 3 adds ON DELETE CASCADE — so a
-- quarantined row is a message-deleting timer, not merely an inert one. Applied
-- to already-tombstoned conversations that is exactly right (retention already
-- ages their messages out by the same window). Applied to live legacy history
-- it would be a data-destroying migration, which is why the drive-owner tier
-- mints ACTIVE rows rather than quarantined ones.
--
-- SECURITY: this is the counterpart of the "legacy conversation" squat
-- documented at `hasConflictingMessageOwner` (apps/web/src/lib/repositories/
-- conversation-repository.ts). That attack works precisely BECAUSE a legacy
-- conversation has no row: an attacker supplying the victim's conversationId
-- from their own page could cause a row to be inserted in the ATTACKER's name,
-- permanently locking the victim out. Synthesizing every orphan under its
-- evidenced owner closes that window for the whole existing corpus — there is
-- no unowned row left to claim. It is also why tier 1 is the earliest
-- USER-ROLE message and not merely the earliest non-null `userId`: an
-- assistant row can carry the userId of whoever triggered it, which is not the
-- same statement about who owns the thread.
--
-- Idempotent: ON CONFLICT DO NOTHING, and the orphan set is empty on re-run.
DO $$
DECLARE
  minted_active bigint := 0;
  minted_quarantined bigint := 0;
  skipped bigint := 0;
  contested bigint := 0;
BEGIN
  CREATE TEMP TABLE "_0249_orphans" ON COMMIT DROP AS
  WITH orphan AS (
    SELECT
      cm."conversationId"      AS conversation_id,
      -- 1:1 by the pre-audit above, so min() is just a picker.
      min(cm."pageId")         AS page_id,
      min(cm."createdAt")      AS first_at,
      max(cm."createdAt")      AS last_at,
      bool_or(cm."isActive")   AS has_active_message
    FROM "chat_messages" cm
    LEFT JOIN "conversations" c ON c."id" = cm."conversationId"
    WHERE c."id" IS NULL
    GROUP BY cm."conversationId"
  ),
  first_human AS (
    SELECT DISTINCT ON (cm."conversationId")
      cm."conversationId" AS conversation_id,
      cm."userId"         AS user_id
    FROM "chat_messages" cm
    WHERE cm."role" = 'user'
      AND cm."userId" IS NOT NULL
      -- Restricted to the orphan set: conversations that already have a row
      -- are not re-owned by this migration, and on a large corpus this is the
      -- difference between one grouped pass over the orphans and one over
      -- every message ever sent.
      AND EXISTS (SELECT 1 FROM orphan o WHERE o.conversation_id = cm."conversationId")
    ORDER BY cm."conversationId", cm."createdAt" ASC, cm."id" ASC
  )
  SELECT
    o.conversation_id,
    o.page_id,
    o.first_at,
    o.last_at,
    o.has_active_message,
    COALESCE(fh.user_id, p."createdBy", d."ownerId") AS owner_id
  FROM orphan o
  LEFT JOIN first_human fh ON fh.conversation_id = o.conversation_id
  LEFT JOIN "pages"  p ON p."id" = o.page_id
  LEFT JOIN "drives" d ON d."id" = p."driveId";

  -- An owner was resolved: mint the row. `isActive` mirrors the messages —
  -- live history stays live, a fully tombstoned conversation is quarantined
  -- (see the header). `updatedAt` is the last message for live rows, and
  -- `now()` for quarantined ones so the retention grace period runs from this
  -- migration rather than from a legacy timestamp already past it.
  WITH inserted AS (
    INSERT INTO "conversations" (
      "id", "userId", "title", "type", "contextId", "sessionId",
      "closedInSessionAt", "lastMessageAt", "createdAt", "updatedAt",
      "isActive", "isShared"
    )
    SELECT
      o.conversation_id, o.owner_id, NULL, 'page', o.page_id, NULL,
      NULL, o.last_at, o.first_at,
      CASE WHEN o.has_active_message THEN o.last_at ELSE now() END,
      o.has_active_message, false
    FROM "_0249_orphans" o
    WHERE o.owner_id IS NOT NULL
    ON CONFLICT ("id") DO NOTHING
    RETURNING "isActive" AS active
  )
  SELECT
    count(*) FILTER (WHERE active),
    count(*) FILTER (WHERE NOT active)
  INTO minted_active, minted_quarantined
  FROM inserted;

  -- Tier 4: nothing resolved, so nothing can be minted (`conversations.userId`
  -- is NOT NULL and FK'd). Skipped rather than guessed — and reported loudly,
  -- because every skip is a row the later `VALIDATE CONSTRAINT`
  -- (Phase 4 PR 14) will refuse. Reachable only where the FK chain
  -- chat_messages.pageId → pages.driveId → drives.ownerId is broken, i.e. on a
  -- restored or repaired corpus — which is exactly the situation in which a
  -- migration must neither invent an owner nor abort.
  SELECT count(*) INTO skipped
  FROM "_0249_orphans" o
  WHERE o.owner_id IS NULL;

  -- Ownership contested by the data itself: more than one human spoke in a
  -- conversation that had no row. Tier 1 still decides (earliest wins, per the
  -- locked rule), but the losers keep read access only through sharing, so the
  -- count is surfaced.
  SELECT count(*) INTO contested
  FROM (
    SELECT cm."conversationId"
    FROM "chat_messages" cm
    JOIN "_0249_orphans" o ON o.conversation_id = cm."conversationId"
    WHERE cm."role" = 'user' AND cm."userId" IS NOT NULL
    GROUP BY cm."conversationId"
    HAVING count(DISTINCT cm."userId") > 1
  ) multi;

  RAISE NOTICE 'messages unification (0249) orphan synthesis: % minted live, % QUARANTINED (isActive=false, unclaimable — every message already tombstoned), % SKIPPED (no owner resolvable — these will fail the later VALIDATE CONSTRAINT), % conversation(s) had more than one human author (earliest wins).',
    minted_active, minted_quarantined, skipped, contested;

  IF skipped > 0 THEN
    RAISE WARNING 'messages unification (0249): % orphan conversation(s) were skipped and still have no conversations row. Repair them before Phase 4 PR 14 runs VALIDATE CONSTRAINT on chat_messages_conversationId_conversations_id_fk.', skipped;
  END IF;
END $$;--> statement-breakpoint

-- ── 3. THE FK, NOT VALID ──────────────────────────────────────────────────
-- Instant: NOT VALID skips the full-table scan that a normal ADD CONSTRAINT
-- performs, while still installing the referential triggers — so from this
-- moment a NEW `chat_messages` row (or an UPDATE of `conversationId`) must
-- name a real conversation, and deleting a conversation cascades. Only the
-- pre-existing rows go unchecked, and only until the later
-- `VALIDATE CONSTRAINT` (Phase 4 PR 14), which takes no exclusive lock.
--
-- ON DELETE CASCADE, matching `messages.conversationId` (the merge target) —
-- and required for correctness of paths that exist today: the retention engine
-- and `purgeInactiveConversations` hard-delete soft-deleted `conversations`
-- rows, and soft-delete tombstones the conversation and its messages together
-- (`softDeleteConversation`). Under NO ACTION those purges would start
-- throwing the moment any message row outlived its conversation's cutoff. What
-- IS new: a conversation delete now takes its `chat_messages` with it instead
-- of orphaning them (see the PR body's cascade-path inventory).
--
-- Declared here rather than in the drizzle schema: `NOT VALID` has no drizzle
-- expression, and `core.ts` importing `conversations.ts` would close an import
-- cycle. Documented on the column (packages/db/src/schema/core.ts).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chat_messages_conversationId_conversations_id_fk'
      AND conrelid = 'public.chat_messages'::regclass
  ) THEN
    ALTER TABLE "chat_messages"
      ADD CONSTRAINT "chat_messages_conversationId_conversations_id_fk"
      FOREIGN KEY ("conversationId") REFERENCES "public"."conversations"("id")
      ON DELETE cascade ON UPDATE no action
      NOT VALID;
  END IF;
END $$;--> statement-breakpoint

-- ── 4. INDEX GATE (both paths, deliberately) ──────────────────────────────
-- The two parity indexes below are sized for the corpus `messages` WILL hold
-- after the backfill (Phase 4 PR 10) — i.e. for `chat_messages`'s row count,
-- not for `messages`'s current one. Prod's count is not knowable from the
-- repo, so both paths ship and the migration picks at runtime:
--
--   below the gate → build them here, inline. Instant on a small table, and it
--                    is the ONLY path that runs on tenant/onprem, where no
--                    operator exists to run anything by hand.
--   above the gate → skip them, and say so. This path once pointed at
--                    scripts/deferred-migrations/0248-messages-unification-indexes.sql
--                    (the same two indexes as CREATE INDEX CONCURRENTLY, which
--                    cannot run inside a migration's transaction block). That
--                    script has since been REMOVED on purpose: both indexes are
--                    on `messages."pageId"`, the transitional column 0253 drops,
--                    so running it either duplicates work 0253 is about to undo
--                    or — after 0253 — builds an index on a column that is gone.
--                    So the NOTICE states the skip rather than naming a path an
--                    operator cannot follow.
--
-- `reltuples` is an estimate and is -1 on a table that has never been analyzed
-- (PG >= 14), so the unknown case falls back to a bounded probe rather than
-- guessing: reading at most GATE+1 rows costs a bounded scan and cannot be the
-- thing that makes this migration slow.
DO $$
DECLARE
  gate constant bigint := 5000000;
  approx_rows bigint;
  probed bigint;
BEGIN
  SELECT reltuples::bigint INTO approx_rows
  FROM pg_class
  WHERE relname = 'chat_messages' AND relnamespace = 'public'::regnamespace AND relkind = 'r';

  IF approx_rows IS NULL OR approx_rows < 0 THEN
    SELECT count(*) INTO probed FROM (SELECT 1 FROM "chat_messages" LIMIT gate + 1) bounded;
    approx_rows := probed;
    RAISE NOTICE 'messages unification (0249): chat_messages has no analyze statistics; bounded probe counted % row(s) (capped at %).', approx_rows, gate + 1;
  END IF;

  IF approx_rows <= gate THEN
    CREATE INDEX IF NOT EXISTS "messages_page_id_idx" ON "messages" USING btree ("pageId");
    CREATE INDEX IF NOT EXISTS "messages_page_id_is_active_created_at_idx" ON "messages" USING btree ("pageId", "isActive", "createdAt");
    RAISE NOTICE 'messages unification (0249): parity indexes built inline (chat_messages ~% rows, gate %).', approx_rows, gate;
  ELSE
    RAISE NOTICE 'messages unification (0249): parity indexes SKIPPED, deliberately (chat_messages ~% rows exceeds the % gate). There is nothing to run by hand: both indexes are on messages."pageId", the transitional column 0253 drops later in this same upgrade. Build them manually ONLY if you intend to sit on this schema without applying 0253.', approx_rows, gate;
  END IF;
END $$;
