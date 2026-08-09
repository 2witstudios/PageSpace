-- Promoted-project Sprite reclaim trigger — the machine_projects arm of
-- 0209_sprite_reclaim_triggers.sql. See that migration's header for the full
-- design: every hard delete of a tracking row must move its Sprite pointer into
-- `machine_sprite_reclaims` (no FKs — nothing can cascade IT away) inside the
-- deleting transaction, so the pointer outlives the resource no matter which
-- delete path fired (removeProject, page purge, drive delete, account erasure,
-- a hand-run DELETE in psql).
--
-- machine_projects needs one extra condition the branch trigger doesn't:
-- `sandboxId IS NULL` is the UNPROMOTED state (the project is just a checkout
-- on the owning Machine's Sprite), so there is no Sprite of its own to rescue.
-- A stamped `spriteTornDownAt` means the Sprite is already confirmed gone —
-- and `sandboxId` is a reused NAME, so enqueueing it again could kill a
-- replacement VM that legitimately took the name.

DROP TRIGGER IF EXISTS machine_projects_sprite_reclaim ON machine_projects;

-- SECURITY DEFINER + pinned search_path for the same reason as 0209: this sits
-- on the critical path of every page/drive/user delete, including Art. 17
-- erasure, and a role allowed to DELETE from pages but lacking INSERT on the
-- outbox must never have its delete fail.
CREATE OR REPLACE FUNCTION machine_projects_capture_sprite_reclaim()
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

CREATE TRIGGER machine_projects_sprite_reclaim
  AFTER DELETE ON machine_projects
  FOR EACH ROW
  EXECUTE FUNCTION machine_projects_capture_sprite_reclaim();

-- No backfill: machine_projects promotion ships in the same release as this
-- trigger, so no promoted row can predate it.
