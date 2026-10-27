-- Custom SQL migration file, put your code below! --

-- Content Tags epic, Phase 2 — SCOPE COHERENCE for `content_tags`, in the database.
--
-- The foreign keys added by 0268 only prove that each referenced row EXISTS. They
-- say nothing about whether the referenced rows belong TOGETHER, and three ways of
-- being incoherent survived them (all three confirmed accepted against a migrated
-- database before this migration was written):
--
--   1. a tag from drive A assigned to a page in drive B — which breaks the whole
--      point of `UNIQUE (driveId, normalizedKey)`: the vocabulary is drive-scoped
--      exactly so one drive's words are not another's;
--   2. `targetKind='channel_message'` whose message lives on a DIFFERENT page than
--      the row's own `pageId`;
--   3. `targetKind='ai_message'` whose conversation is not page-scoped to `pageId`
--      at all (a drive or global thread, or another page's thread).
--
-- (2) and (3) matter more than they look. `pageId` is denormalized onto every row
-- so that permission checks and the page-delete cascade work uniformly across
-- target kinds — so a row whose `pageId` disagrees with its message is a row that
-- is PERMISSIONED AGAINST THE WRONG PAGE. It would be read by whoever can see the
-- page it claims, not the page its content is actually on.
--
-- WHY A TRIGGER AND NOT COMPOSITE FOREIGN KEYS. The FK route needs `driveId`
-- denormalized onto `content_tags`, a `UNIQUE (id, "driveId")` on `tags`, another
-- on `pages`, a `UNIQUE (id, "pageId")` on `channel_messages`, and two composite
-- FKs — and it still cannot express (3) at all, because `messages` has no `pageId`
-- and reaches a page only through `conversations.contextId`, which is polymorphic
-- with NO foreign key. That route ends with two enforcement mechanisms on one
-- table and four new unique indexes on large tables. One trigger covers all three
-- legs, adds no columns and no indexes, and leaves the shape 0268 established
-- exactly as it is. Trigger precedent in this schema: 0229/0233/0238/0263/0265.
--
-- NO `SECURITY DEFINER`, deliberately — unlike those five. They exist to let a
-- caller who may DELETE a row INSERT into an outbox it has no rights on, so they
-- must run as the owner. This one only ever READS tables that any caller able to
-- write `content_tags` can already read, and it must NOT gain privilege: a
-- validation trigger that can see more than its caller is a way to leak the
-- existence of rows through timing or an error message. `search_path` is still
-- pinned, because an unpinned one is a hijack in any function.
--
-- NO BACKFILL and no `NOT VALID` equivalent: `content_tags` is created by 0268 in
-- this same release and has no writer in any shipped image, so no existing row can
-- predate the invariant.
--
-- WHAT THIS DELIBERATELY DOES NOT COVER — read this before Phase 3. The trigger
-- fires on `content_tags` INSERT/UPDATE, so it cannot see a page MOVING BETWEEN
-- DRIVES afterwards (`page-cross-drive-move-service.ts` rewrites `pages."driveId"`
-- for a whole subtree). After such a move a tag left behind in the source drive's
-- vocabulary is stale, exactly as a task's assignee agent is — and the house
-- answer to that is an application-level scrub in the move transaction, the shape
-- `scrubDriveScopedTaskAssociations` already implements for task assignments and
-- trigger workflows. It is not written here because nothing writes `content_tags`
-- yet, so there is no row to scrub; it MUST land with the first writer. Blocking
-- the move from the database instead was rejected on purpose: it would regress a
-- working feature to protect rows that do not exist.

CREATE OR REPLACE FUNCTION content_tags_enforce_target_scope()
RETURNS TRIGGER
SET search_path = public
AS $$
DECLARE
  page_drive_id text;
  tag_drive_id text;
  message_page_id text;
  page_scoped_conversation boolean;
BEGIN
  SELECT "driveId" INTO page_drive_id FROM public.pages WHERE id = NEW."pageId";
  SELECT "driveId" INTO tag_drive_id FROM public.tags WHERE id = NEW."tagId";

  -- IS DISTINCT FROM, not <>, and the reason is narrower than it looks — stated
  -- precisely because the loose version ("otherwise the row is waved through")
  -- is wrong and a reviewer will check it.
  --
  -- A BEFORE trigger runs ahead of BOTH the foreign keys and the table CHECK
  -- (verified: inserting a dangling "tagId" reaches this RAISE, not a 23503).
  -- So these lookups genuinely CAN return NULL here, and with `<>` the
  -- comparison would be NULL, not TRUE, and this branch would fall through.
  -- The row still would not survive — the FK behind us refuses it — so the
  -- practical difference is WHICH constraint reports the failure, not whether
  -- the row lands. That is still worth having: this message names both drives,
  -- where a bare 23503 names neither, and a guard whose logic is total does not
  -- depend on a later constraint to be correct. `refuses a dangling tag
  -- reference itself` in the integration suite pins exactly that.
  IF tag_drive_id IS DISTINCT FROM page_drive_id THEN
    RAISE EXCEPTION
      'content_tags scope: tag % is in drive %, but page % is in drive %',
      NEW."tagId", tag_drive_id, NEW."pageId", page_drive_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."targetKind" = 'channel_message' THEN
    SELECT "pageId" INTO message_page_id
      FROM public.channel_messages WHERE id = NEW."channelMessageId";

    IF message_page_id IS DISTINCT FROM NEW."pageId" THEN
      RAISE EXCEPTION
        'content_tags scope: channel message % is on page %, but the tag claims page %',
        NEW."channelMessageId", message_page_id, NEW."pageId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."targetKind" = 'ai_message' THEN
    -- The page-scope rule, stated once in the repo and copied here rather than
    -- invented: `packages/lib/src/repositories/conversation-cleanup.ts` defines a
    -- conversation as belonging to a page in exactly two ways — a `type='page'`
    -- thread whose `contextId` IS the page, or a `type='client'` thread whose
    -- (write-once) `agentPageId` is the page. A `drive` or `global` thread is
    -- NEVER page-scoped. `contextId` carries a driveId for drive threads and NULL
    -- for global ones, which is why the `type` test is load-bearing rather than
    -- decorative: without it a drive thread would be compared on a column that
    -- holds a drive id.
    SELECT EXISTS (
      SELECT 1
        FROM public.messages m
        JOIN public.conversations c ON c.id = m."conversationId"
       WHERE m.id = NEW."aiMessageId"
         AND (
              (c.type = 'page' AND c."contextId" = NEW."pageId")
           OR (c.type = 'client' AND c."agentPageId" = NEW."pageId")
         )
    ) INTO page_scoped_conversation;

    IF NOT page_scoped_conversation THEN
      RAISE EXCEPTION
        'content_tags scope: AI message % is not in a conversation scoped to page %',
        NEW."aiMessageId", NEW."pageId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS content_tags_target_scope ON content_tags;
--> statement-breakpoint

-- BEFORE, not AFTER: this decides whether the row may exist, so it belongs on the
-- way in. FOR EACH ROW with no WHEN clause — every kind needs the drive check, and
-- the two message checks are gated inside the body by `targetKind` instead, where
-- the reason for each can be written down next to it.
--
-- `UPDATE OF <columns>` rather than a bare UPDATE, and the list is exactly the
-- columns the invariant is a function of. Everything else on the row — `anchor`,
-- `anchorStatus`, `confidence`, `createdBy`, `updatedAt` — cannot make a coherent
-- row incoherent.
--
-- THIS IS A COMPLIANCE PROPERTY BEFORE IT IS A PERFORMANCE ONE, and it took
-- running it to see that. `createdBy` is ON DELETE SET NULL, so erasing a user
-- issues an UPDATE against every row they ever tagged. Under a bare `UPDATE`,
-- if ANY of those rows had been left stale by a cross-drive page move (see
-- below), the trigger refuses the SET NULL and the Art 17 erasure fails outright
-- — the subject cannot be deleted at all. Verified directly against Postgres:
-- the bare form raises `content_tags scope: tag ... is in drive ...` from inside
-- `UPDATE ONLY "content_tags" SET "createdBy" = NULL` and leaves the user row in
-- place. A guard that can block erasure is the failure mode 0256's header and
-- the reclaim triggers are both written to avoid; this column list is what keeps
-- this one off that path. `must never block Art 17 erasure` in the integration
-- suite pins it.
--
-- The performance argument is real too, just secondary: `reanchorPageTags` is
-- specified to forward-port every `text` anchor on a page on EVERY save, writing
-- `anchor`/`anchorStatus` for each one. Under a bare `UPDATE` this trigger would
-- sit in that loop for the life of the product, re-proving a fact none of those
-- writes can change.
--
-- Adding a scope-bearing column later means adding it HERE too, or it silently
-- stops being checked on update. That is the one hazard this form introduces, and
-- it is why the list is spelled out rather than being written as an exclusion.
CREATE TRIGGER content_tags_target_scope
  BEFORE INSERT OR UPDATE OF "tagId", "pageId", "targetKind", "channelMessageId", "aiMessageId"
  ON content_tags
  FOR EACH ROW
  EXECUTE FUNCTION content_tags_enforce_target_scope();
