-- Agent-session Sprite reclaim trigger — the `agent_sessions` arm of
-- 0209_sprite_reclaim_triggers.sql / 0219_project_sprite_reclaim_trigger.sql /
-- 0229_agent_terminal_sprite_reclaim_trigger.sql. See 0209's header for the full
-- design: every hard delete of a tracking row must move its Sprite pointer into
-- `machine_sprite_reclaims` (no foreign keys — nothing can cascade IT away)
-- inside the deleting transaction, so the pointer OUTLIVES the resource no
-- matter which delete path fired.
--
-- An agent session owns its own Sprite, and `agent_sessions.conversationId` is
-- an `ON DELETE CASCADE` FK off `conversations` (which itself cascades off
-- `users`), with a second cascade off `pages` via `agentPageId`. So deleting a
-- conversation, hard-deleting/purging the AI_CHAT page, a drive delete, the
-- 30-day GDPR purge, or the account-erasure worker would each cascade-delete the
-- session row and strand its live Sprite, billing forever with nothing pointing
-- at it. This rescues the pointer as the row dies.
--
-- Same two conditions `machine_projects`/`machine_agent_terminals` need:
-- `sandboxId IS NULL` is a session that never provisioned (the common case —
-- most conversations never acquire a sandbox, so their rows have no Sprite of
-- their own to rescue), and a stamped `spriteTornDownAt` means the Sprite is
-- already confirmed gone — re-enqueueing its reused NAME could kill a
-- replacement VM that legitimately took the name.
--
-- SCOPE LIMIT — read this before relying on the trigger. Postgres fires
-- row-level triggers for rows deleted by a direct DELETE and by a referential
-- CASCADE, but NOT for rows removed by DROP TABLE (nor by TRUNCATE, which needs
-- its own statement-level trigger). A table-level teardown therefore rescues
-- NOTHING through this path: the Phase 8 teardown must rescue the pointers
-- EXPLICITLY (drain `agent_sessions` into `machine_sprite_reclaims` first, then
-- drop). This trigger covers row-level deletes only.
--
-- No trigger on `agent_session_shells`: a shell has no Sprite pointer at all —
-- every shell in a session shares the SESSION's one Sprite — so there is nothing
-- for a reclaim to carry, and enqueueing the session's sandbox when a shell row
-- dies would ask the reconciler to destroy a VM the session is still using.

DROP TRIGGER IF EXISTS agent_sessions_sprite_reclaim ON agent_sessions;

-- SECURITY DEFINER + a pinned search_path for the same reason as 0209/0219/0229:
-- this sits on the critical path of every conversation/page/drive/user delete,
-- including Art. 17 erasure, and a role allowed to DELETE from `conversations`
-- or `pages` but lacking INSERT on the outbox must never have its delete fail.
CREATE OR REPLACE FUNCTION agent_sessions_capture_sprite_reclaim()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD."sandboxId" IS NOT NULL AND OLD."spriteTornDownAt" IS NULL THEN
    INSERT INTO public.machine_sprite_reclaims ("sandboxId", "spriteInstanceId")
    VALUES (OLD."sandboxId", OLD."spriteInstanceId")
    ON CONFLICT ("sandboxId") DO UPDATE
      -- A newer generation took this name; the pointer must chase the VM that
      -- is actually alive now, not the one a stale row remembers.
      SET "spriteInstanceId" = COALESCE(EXCLUDED."spriteInstanceId", public.machine_sprite_reclaims."spriteInstanceId");
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agent_sessions_sprite_reclaim
  AFTER DELETE ON agent_sessions
  FOR EACH ROW
  EXECUTE FUNCTION agent_sessions_capture_sprite_reclaim();

-- No backfill: `agent_sessions` is created one migration earlier (0232), so no
-- row can predate this trigger with a live Sprite.
