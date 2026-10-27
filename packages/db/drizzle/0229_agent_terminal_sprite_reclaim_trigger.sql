-- Per-session-Sprite reclaim trigger — the machine_agent_terminals arm of
-- 0209_sprite_reclaim_triggers.sql / 0219_project_sprite_reclaim_trigger.sql.
-- See 0209's header for the full design: every hard delete of a tracking row
-- must move its Sprite pointer into `machine_sprite_reclaims` (no FKs — nothing
-- can cascade IT away) inside the deleting transaction, so the pointer outlives
-- the resource no matter which delete path fired.
--
-- Each machine_agent_terminals row now owns its OWN Sprite (sessions-per-location
-- provisioning), and its `machineId` FK is `onDelete: cascade` off `pages`. So a
-- page hard-delete/purge — the 30-day GDPR purge, "delete permanently", a drive
-- delete, the account-erasure worker — would cascade-delete the row and strand
-- its live Sprite, billing forever with nothing pointing at it. This rescues the
-- pointer as the row dies.
--
-- machine_agent_terminals needs the same two conditions machine_projects does:
-- `sandboxId IS NULL` is a legacy/unprovisioned row (no Sprite of its own to
-- rescue), and a stamped `spriteTornDownAt` means the Sprite is already confirmed
-- gone — re-enqueueing its reused NAME could kill a replacement VM that
-- legitimately took the name.

DROP TRIGGER IF EXISTS machine_agent_terminals_sprite_reclaim ON machine_agent_terminals;

-- SECURITY DEFINER + pinned search_path for the same reason as 0209/0219: this
-- sits on the critical path of every page/drive/user delete, including Art. 17
-- erasure, and a role allowed to DELETE from pages but lacking INSERT on the
-- outbox must never have its delete fail.
CREATE OR REPLACE FUNCTION machine_agent_terminals_capture_sprite_reclaim()
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

CREATE TRIGGER machine_agent_terminals_sprite_reclaim
  AFTER DELETE ON machine_agent_terminals
  FOR EACH ROW
  EXECUTE FUNCTION machine_agent_terminals_capture_sprite_reclaim();

-- No backfill: per-session Sprites ship in the same release as this trigger, so
-- no machine_agent_terminals row can predate it with a live Sprite of its own.
