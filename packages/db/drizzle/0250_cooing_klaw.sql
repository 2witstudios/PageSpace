-- ══════════════════════════════════════════════════════════════════════════
-- Epic "Agent-Session Single Source of Truth", Phase 4 — integrity constraints
-- (the leaf that follows 0248's expand step).
--
-- Everything here is a constraint that has ALWAYS been true of correctly
-- written rows and never enforced. All four are added NOT VALID, deliberately:
--   * new and updated rows are checked immediately (a NOT VALID constraint is
--     fully enforced going forward — it only skips the initial verification
--     scan), so this is the cheapest possible way to stop the drift;
--   * the legacy corpus is neither scanned nor rejected, so no rolling deploy
--     can be blocked by a row written years ago;
--   * `VALIDATE CONSTRAINT` — which takes only a SHARE UPDATE EXCLUSIVE lock
--     and can run at any later time — is left to the PR that has looked at
--     real data (Phase 4 PR 14, alongside 0248's chat_messages FK).
--
-- The statements `db:generate` produced are rewritten below to add NOT VALID
-- and an existence guard (repo convention: hand-append to your OWN new
-- migration; never edit an applied one — precedent 0246/0225/0222/0116). The
-- pre-audit NOTICE reports what a future VALIDATE would find, changing nothing.
-- ══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  dangling bigint;
  bad_global bigint;
  bad_page bigint;
  bad_drive bigint;
BEGIN
  SELECT count(*) INTO dangling
  FROM "ai_stream_sessions" s
  LEFT JOIN "conversations" c ON c."id" = s."conversation_id"
  WHERE c."id" IS NULL;

  SELECT
    count(*) FILTER (WHERE "type" = 'global' AND "contextId" IS NOT NULL),
    count(*) FILTER (WHERE "type" = 'page'   AND "contextId" IS NULL),
    count(*) FILTER (WHERE "type" = 'drive'  AND "contextId" IS NULL)
  INTO bad_global, bad_page, bad_drive
  FROM "conversations";

  RAISE NOTICE 'integrity constraints (0249) pre-audit: % ai_stream_sessions row(s) reference a missing conversation; conversations violations — global-with-context %, page-without-context %, drive-without-context %. All are grandfathered by NOT VALID and must be repaired before VALIDATE CONSTRAINT.',
    dangling, bad_global, bad_page, bad_drive;
END $$;--> statement-breakpoint
-- The stream table's conversation link becomes real. Only possible after
-- 0248's orphan synthesis: page-chat streams carry the same self-minted
-- conversationId as chat_messages, so before that sweep a large share of these
-- rows pointed at nothing. ON DELETE CASCADE — per-generation state (parts
-- checkpoints, heartbeat, abort mailbox) is meaningless without its
-- conversation, and those checkpoints are message content that must not
-- outlive a user's erasure.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_stream_sessions_conversation_id_conversations_id_fk'
      AND conrelid = 'public.ai_stream_sessions'::regclass
  ) THEN
    ALTER TABLE "ai_stream_sessions"
      ADD CONSTRAINT "ai_stream_sessions_conversation_id_conversations_id_fk"
      FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id")
      ON DELETE cascade ON UPDATE no action
      NOT VALID;
  END IF;
END $$;--> statement-breakpoint
-- type ⇄ contextId. See packages/db/src/schema/conversations.ts for why each
-- is phrased `type <> X OR ...` (rows of every other type stay unconstrained)
-- and why the 'drive' arm ships despite having no writer today.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'conversations_global_context_null_chk'
      AND conrelid = 'public.conversations'::regclass
  ) THEN
    ALTER TABLE "conversations"
      ADD CONSTRAINT "conversations_global_context_null_chk"
      CHECK ("conversations"."type" <> 'global' OR "conversations"."contextId" IS NULL)
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'conversations_page_context_present_chk'
      AND conrelid = 'public.conversations'::regclass
  ) THEN
    ALTER TABLE "conversations"
      ADD CONSTRAINT "conversations_page_context_present_chk"
      CHECK ("conversations"."type" <> 'page' OR "conversations"."contextId" IS NOT NULL)
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'conversations_drive_context_present_chk'
      AND conrelid = 'public.conversations'::regclass
  ) THEN
    ALTER TABLE "conversations"
      ADD CONSTRAINT "conversations_drive_context_present_chk"
      CHECK ("conversations"."type" <> 'drive' OR "conversations"."contextId" IS NOT NULL)
      NOT VALID;
  END IF;
END $$;
