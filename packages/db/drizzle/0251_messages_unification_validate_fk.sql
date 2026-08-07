-- ══════════════════════════════════════════════════════════════════════════
-- Epic "Agent-Session Single Source of Truth", Phase 4 PR 14 — the SOAK GATE.
--
-- The application half of this PR stops every `chat_messages` write, leaving
-- `messages` as the sole write target. This is the database half: it turns
-- 0248's `NOT VALID` foreign key into a validated one, so
-- `chat_messages.conversationId` is finally proven — for the WHOLE corpus, not
-- just for new rows — to name a real `conversations` row.
--
-- Why validate a constraint on a table that is about to be dropped (PR 15)?
-- Because the drop is not the point. `messages` is a copy of this table under
-- the same primary keys, and `messages.conversationId` has a validated,
-- cascading FK. Any legacy row whose conversation does not exist is a row the
-- unified table cannot hold — it would have been REFUSED by that FK — so
-- validating here is how we prove the copy can be complete before PR 15
-- deletes the original. A VALIDATE that passes is the receipt.
--
-- No schema diff: `db:generate --custom` produced an empty file and everything
-- below is hand-written (repo convention — precedent 0248/0246/0225/0222/0116:
-- hand-append to your OWN new migration; never edit an applied one).
--
--   1. IDEMPOTENCE GATE — `convalidated` in pg_constraint. A re-run does
--      nothing, and a database that has never seen 0248 is not silently
--      "validated" by omission.
--   2. PRE-VALIDATE AUDIT — the two things 0248 left behind, handled BEFORE
--      the VALIDATE rather than discovered as an opaque 23503 inside it:
--        a. the orphan conversations 0248 SKIPPED (it RAISEd WARNING with a
--           count). Those rows still violate the FK → FAIL LOUDLY, naming them.
--        b. the existing `conversations` rows that disagree with their
--           `chat_messages` about the page (0248 RAISEd NOTICE). They do NOT
--           violate the FK; they are re-counted and reported so PR 15 inherits
--           a number rather than a rumour.
--   3. VALIDATE CONSTRAINT — a SHARE UPDATE EXCLUSIVE lock only: concurrent
--      SELECT/INSERT/UPDATE/DELETE on `chat_messages` keep running.
-- ══════════════════════════════════════════════════════════════════════════

-- ── 1 + 2. GATE, THEN THE PRE-VALIDATE AUDIT ──────────────────────────────
-- The audit runs INSIDE the gate on purpose: on an already-validated database
-- there is nothing left to audit (Postgres itself now guarantees the answer),
-- and re-scanning `chat_messages` on every deploy of every tenant would be a
-- real cost for a question that cannot come back.
DO $$
DECLARE
  fk_exists boolean;
  fk_validated boolean;
  orphan_conversations bigint;
  orphan_rows bigint;
  orphan_sample text;
  mismatched bigint;
  mismatch_sample text;
BEGIN
  SELECT true, convalidated INTO fk_exists, fk_validated
  FROM pg_constraint
  WHERE conname = 'chat_messages_conversationId_conversations_id_fk'
    AND conrelid = 'public.chat_messages'::regclass;

  IF fk_exists IS NOT TRUE THEN
    -- 0248 adds it unconditionally, so this can only mean the constraint was
    -- dropped by hand. Refusing is better than silently re-adding a DIFFERENT
    -- constraint (the ON DELETE CASCADE is load-bearing for retention).
    RAISE EXCEPTION 'messages unification (0250): constraint chat_messages_conversationId_conversations_id_fk does not exist. Migration 0248 adds it; it must not be dropped. Re-add it exactly as 0248 does (FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE, NOT VALID) and re-run.';
  END IF;

  IF fk_validated THEN
    RAISE NOTICE 'messages unification (0250): FK already validated — nothing to do.';
    RETURN;
  END IF;

  -- ── 2a. THE BLOCKER: rows 0248 could not give a parent ──────────────────
  -- 0248's synthesis ladder is (earliest user-role author → page creator →
  -- drive owner), and tier 4 is a SKIP, because `conversations.userId` is NOT
  -- NULL and FK'd to `users`: a row with no resolvable owner cannot be minted
  -- at all, quarantined or otherwise. Every skip is a row this VALIDATE would
  -- reject.
  --
  -- On a consistent database this set is EMPTY by construction, and that is
  -- worth stating precisely rather than hoping: `chat_messages.pageId` is NOT
  -- NULL and FK'd to `pages`, `pages.driveId` is NOT NULL and FK'd to
  -- `drives`, and `drives.ownerId` is NOT NULL and FK'd to `users` — so tier 3
  -- always resolves. Reaching this branch means one of those chains is broken,
  -- which is the shape of a partially restored or hand-repaired corpus.
  --
  -- FAIL LOUDLY rather than repair. There is no honest repair available here:
  -- minting a conversation needs an owner, and this migration inventing one
  -- would hand a stranger's chat history to whoever it picked; deleting the
  -- messages instead would make a data-destroying migration out of a
  -- constraint-validating one. Both are decisions for a human with the data in
  -- front of them, so this raises with the counts, the ids, and the two
  -- choices spelled out.
  SELECT count(*), coalesce(sum(rows), 0)::bigint INTO orphan_conversations, orphan_rows
  FROM (
    SELECT cm."conversationId", count(*) AS rows
    FROM "chat_messages" cm
    LEFT JOIN "conversations" c ON c."id" = cm."conversationId"
    WHERE c."id" IS NULL
    GROUP BY cm."conversationId"
  ) orphans;

  IF orphan_conversations > 0 THEN
    SELECT string_agg(id, ', ') INTO orphan_sample
    FROM (
      SELECT DISTINCT cm."conversationId" AS id
      FROM "chat_messages" cm
      LEFT JOIN "conversations" c ON c."id" = cm."conversationId"
      WHERE c."id" IS NULL
      ORDER BY 1
      LIMIT 50
    ) sample;

    RAISE EXCEPTION E'messages unification (0250) cannot validate the chat_messages FK: % conversation id(s), covering % message row(s), still have no "conversations" row. These are migration 0248''s SKIPPED orphans (it raised a WARNING with the same count).\nFirst (up to 50): %\nRepair, then re-run. Either (a) INSERT a "conversations" row for each — type=''page'', contextId = the messages'' "pageId", userId = a deliberately chosen owner (0248''s ladder is: earliest user-role message author, else pages."createdBy", else drives."ownerId"), isActive = false if every message is already soft-deleted; or (b) DELETE the message rows if they are known garbage. This migration will not choose for you: option (a) hands someone a chat history and option (b) destroys one.',
      orphan_conversations, orphan_rows, orphan_sample;
  END IF;

  -- ── 2b. THE NON-BLOCKER: conversations that disagree about the page ─────
  -- 0248 reported these as a NOTICE and did not repair them. They satisfy the
  -- FK (the parent row exists), so they cannot fail the VALIDATE below — but
  -- they are the reader cutover's known blind spot: every reader now derives a
  -- page conversation's page from `conversations.contextId`, and for these
  -- rows that disagrees with the `chat_messages.pageId` the history was filed
  -- under. Re-counted here so the soak has a number, and so PR 15 (which drops
  -- `messages.pageId`, the last column that still remembers the other answer)
  -- inherits a measurement instead of a rumour.
  SELECT count(*) INTO mismatched
  FROM (
    SELECT cm."conversationId"
    FROM "chat_messages" cm
    JOIN "conversations" c ON c."id" = cm."conversationId"
    WHERE c."type" <> 'page' OR c."contextId" IS DISTINCT FROM cm."pageId"
    GROUP BY cm."conversationId"
  ) mismatches;

  IF mismatched > 0 THEN
    SELECT string_agg(id, ', ') INTO mismatch_sample
    FROM (
      SELECT cm."conversationId" AS id
      FROM "chat_messages" cm
      JOIN "conversations" c ON c."id" = cm."conversationId"
      WHERE c."type" <> 'page' OR c."contextId" IS DISTINCT FROM cm."pageId"
      GROUP BY cm."conversationId"
      ORDER BY 1
      LIMIT 50
    ) sample;

    RAISE WARNING 'messages unification (0250): % conversation(s) disagree with their chat_messages about the page (type <> ''page'', or contextId <> pageId). This does NOT block the FK validation below and is NOT repaired here — the rows are readable, just filed under the page their conversation names rather than the one their legacy rows do. First (up to 50): %',
      mismatched, mismatch_sample;
  END IF;

  RAISE NOTICE 'messages unification (0250) pre-validate audit: 0 orphan conversations, % page-mismatched conversation(s). Validating the FK.', mismatched;

  -- ── 3. VALIDATE ────────────────────────────────────────────────────────
  -- Now provably a no-op scan: the audit above just established the set it
  -- would reject is empty. SHARE UPDATE EXCLUSIVE only — reads and writes to
  -- `chat_messages` continue throughout; it conflicts only with DDL and
  -- VACUUM FULL.
  ALTER TABLE "chat_messages" VALIDATE CONSTRAINT "chat_messages_conversationId_conversations_id_fk";
END $$;
