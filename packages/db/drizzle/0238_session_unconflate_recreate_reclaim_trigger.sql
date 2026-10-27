-- Custom SQL migration file, put your code below! --

-- Session ≠ conversation un-conflation, final step: re-arm the Sprite reclaim
-- trigger on the REBUILT `agent_sessions`.
--
-- 0236 dropped the table (DROP TABLE takes its triggers with it — the same
-- scope limit 0233's header documents), and 0237 recreated it with its own
-- identity: `id` PK (a session cuid, no longer a conversation id), `driveId`
-- instead of `agentPageId`, because a session is a drive-level workspace that
-- hosts MANY conversations and owns the one sandbox they all share.
--
-- The trigger body is 0233's, unchanged: the Sprite pointer columns
-- (`sandboxId`, `spriteInstanceId`, `spriteTornDownAt`) survived the identity
-- change untouched, and the outbox (`machine_sprite_reclaims`) is FK-less by
-- design so nothing here cares what the tracking row's primary key is. The
-- delete paths it guards shifted with the FKs — a session row now dies via
-- drive delete (`driveId` cascade), owner delete (`ownerId` cascade → GDPR
-- erasure), or a direct end — and every one of them must still move the
-- pointer into the outbox inside the deleting transaction.
--
-- ON CONFLICT DO UPDATE, not DO NOTHING: a newer generation may have taken
-- this reused NAME; the pointer must chase the VM that is actually alive now,
-- not the one a stale outbox row remembers (see 0219's precedent, and the
-- orphaning failure mode filed as issue #2254).

DROP TRIGGER IF EXISTS agent_sessions_sprite_reclaim ON agent_sessions;

-- SECURITY DEFINER + a pinned search_path for the same reason as 0209/0219/0229:
-- this sits on the critical path of every drive/user delete, including Art. 17
-- erasure, and a role allowed to DELETE from `drives` but lacking INSERT on the
-- outbox must never have its delete fail.
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

-- No backfill: 0237 created the table empty (0235 cleared the unreleased rows,
-- rescuing any live pointers through the OLD trigger before 0236 dropped it),
-- so no row can predate this trigger with a live Sprite.
