-- Custom SQL migration file, put your code below! --

-- Epic "Deliberate Per-Drive Boxes", Phase 1 — the Sprite reclaim trigger for
-- `drive_boxes`. Same release as 0262, which creates the table: a box table
-- without this trigger regresses the exact orphan-billing bug the outbox was
-- built for, and "we'll add it next release" is a window in which a deleted
-- box leaves a billing microVM with nothing pointing at it.
--
-- WHY A TRIGGER AND NOT A GUARD ON THE DELETE PATHS. `machine_sprite_reclaims`'
-- own docblock argues this at length and it applies here unchanged: guarding
-- each path is unenforceable (there is always one more), and it cannot work
-- for erasure at all — GDPR Art. 17 must not be blocked by a VM we failed to
-- kill. A box row dies via a drive cascade (`driveId` → `drives`, which itself
-- cascades from a permanent drive delete and from the account-erasure worker),
-- or via a direct delete from the box API. Postgres fires row triggers for
-- rows deleted by a referential CASCADE too, so every one of those paths is
-- covered by this single trigger, and the INSERT rides the deleting
-- transaction: either the pointer moves to the outbox, or the delete does not
-- commit.
--
-- The body is 0233/0238's, adapted only in the names it addresses. That is
-- deliberate — the box's Sprite pointer columns (`sandboxId`,
-- `spriteInstanceId`, `spriteTornDownAt`) are the session table's column for
-- column, the outbox is FK-less by design so it does not care which table a
-- pointer came from, and the drain (`machine-orphan-reconcile`) kills by name
-- with the instance id as an ABA guard. One outbox, one reconciler, two
-- producers.
--
-- `kind='deploy'` boxes are not a special case here and need no branch: their
-- Sprite pointer columns are NULL by CHECK (`drive_boxes_sprite_kind_check`,
-- 0262), so the WHEN clause below can never select one. Their Fly app names
-- reach `app_hosting_reclaims` through the hosting row's own trigger, and the
-- two outboxes stay partitioned by construction rather than by convention.

-- SECURITY DEFINER + a pinned search_path for the same reason as
-- 0209/0219/0229/0238: this sits on the critical path of every drive delete,
-- including Art. 17 erasure, and a role allowed to DELETE from `drives` but
-- lacking INSERT on the outbox must never have its delete fail.
CREATE OR REPLACE FUNCTION drive_boxes_capture_sprite_reclaim()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.machine_sprite_reclaims ("sandboxId", "spriteInstanceId")
  VALUES (OLD."sandboxId", OLD."spriteInstanceId")
  ON CONFLICT ("sandboxId") DO UPDATE
    -- DO UPDATE, not DO NOTHING: a newer generation may have taken this reused
    -- NAME, and the pointer must chase the VM that is actually alive now, not
    -- the one a stale outbox row remembers (0219's precedent; the orphaning
    -- failure mode filed as issue #2254). COALESCE so a NULL instance id never
    -- erases a known one — name-only is the reconciler's weaker fallback, and
    -- downgrading to it would drop the ABA guard on a kill.
    SET "spriteInstanceId" = COALESCE(EXCLUDED."spriteInstanceId", public.machine_sprite_reclaims."spriteInstanceId");
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS drive_boxes_sprite_reclaim ON drive_boxes;--> statement-breakpoint

-- The live-pointer test is a WHEN clause rather than an IF inside the body
-- (0238 states it as an IF; both are correct, and stated here it also keeps
-- the function body a single unconditional statement). "Live" is exactly the
-- partial index's predicate — `sandboxId IS NOT NULL AND spriteTornDownAt IS
-- NULL` — so the trigger, the index and the orphan reconciler all agree on
-- what a live Sprite is. A box whose Sprite was already CONFIRMED destroyed
-- enqueues nothing: there is no VM to reclaim, and a row for a dead name would
-- have the cron chase it forever.
CREATE TRIGGER drive_boxes_sprite_reclaim
  AFTER DELETE ON drive_boxes
  FOR EACH ROW
  WHEN (OLD."sandboxId" IS NOT NULL AND OLD."spriteTornDownAt" IS NULL)
  EXECUTE FUNCTION drive_boxes_capture_sprite_reclaim();

-- No backfill: 0262 created `drive_boxes` in this same release and nothing
-- writes it yet, so no row can predate this trigger holding a live pointer.
