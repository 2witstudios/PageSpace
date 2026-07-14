-- Sprite reclaim triggers — make the pointer to a live microVM UNKILLABLE.
--
-- A Sprite is a real, billing VM, findable only by its `sandboxId`. That id
-- lives in `machine_sessions` / `machine_branches`, both of which FK-cascade off
-- `pages.id` (and off `users.id`). So EVERY hard delete of a page destroys the
-- only pointer to a VM that may still be running: the 30-day GDPR purge, "delete
-- permanently" from the trash, a permanent drive delete, the account-erasure
-- worker — and any path added in the future. The VM then bills forever,
-- unreachable. We found one of these in production and killed it by hand.
--
-- Guarding each delete path is unenforceable (there is always one more), and it
-- cannot work for erasure: GDPR Art. 17 must never be blocked by a Sprite we
-- failed to kill. So we do not guard the deletes — we rescue the pointer.
--
-- These AFTER DELETE triggers copy the `sandboxId` into `machine_sprite_reclaims`
-- (no foreign keys — nothing can cascade IT away) as the tracking row dies.
-- Postgres fires row-level triggers for rows deleted by a referential CASCADE as
-- well as by a direct DELETE, so this captures the id no matter which table's
-- delete started it — including a hand-run `DELETE FROM pages` in psql. The
-- INSERT runs inside the deleting transaction: either the pointer moves, or the
-- delete does not commit. The pointer therefore OUTLIVES the resource.
--
-- The orphan-reconcile cron drains that table with an idempotent kill and only
-- removes a row once the Sprite is CONFIRMED gone, so a failed kill is retried
-- forever instead of being forgotten.

CREATE OR REPLACE FUNCTION machine_sessions_capture_sprite_reclaim()
RETURNS TRIGGER AS $$
BEGIN
  -- A machine_sessions row exists ONLY while we believe its Sprite is live (it
  -- is deleted on a confirmed kill), so any delete of one is a pointer worth
  -- rescuing. Re-enqueueing a Sprite that was in fact already destroyed is
  -- harmless and deliberate: the reconciler's kill is idempotent, so the
  -- redundant attempt simply confirms the death and drops the row — which also
  -- makes this a safety net against a teardown that only THOUGHT it succeeded.
  INSERT INTO machine_sprite_reclaims ("sandboxId")
  VALUES (OLD."sandboxId")
  ON CONFLICT ("sandboxId") DO NOTHING;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION machine_branches_capture_sprite_reclaim()
RETURNS TRIGGER AS $$
BEGIN
  -- A branch row OUTLIVES its Sprite on purpose (it is re-creatable config, and
  -- its branch-scoped machine_agent_terminals FK-cascade off it), so teardown
  -- STAMPS `spriteTornDownAt` rather than deleting. A stamped row's Sprite is
  -- already confirmed gone — there is nothing to reclaim, so skip it. An
  -- UNSTAMPED row being deleted means its Sprite may still be running.
  IF OLD."spriteTornDownAt" IS NULL THEN
    INSERT INTO machine_sprite_reclaims ("sandboxId")
    VALUES (OLD."sandboxId")
    ON CONFLICT ("sandboxId") DO NOTHING;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS machine_sessions_sprite_reclaim ON machine_sessions;
CREATE TRIGGER machine_sessions_sprite_reclaim
  AFTER DELETE ON machine_sessions
  FOR EACH ROW
  EXECUTE FUNCTION machine_sessions_capture_sprite_reclaim();

DROP TRIGGER IF EXISTS machine_branches_sprite_reclaim ON machine_branches;
CREATE TRIGGER machine_branches_sprite_reclaim
  AFTER DELETE ON machine_branches
  FOR EACH ROW
  EXECUTE FUNCTION machine_branches_capture_sprite_reclaim();

-- Backfill: any Sprite whose page is ALREADY trashed and whose teardown never
-- confirmed is, by definition, at risk of being stranded by the next purge. The
-- triggers only capture deletions from here on, so seed the outbox with the
-- pointers that already exist — including the one class this whole workstream
-- started from (a failed teardown behind a trashed page).
--
-- Deliberately NOT seeding Sprites of merely-trashed Machines whose teardown was
-- never requested: those are hibernating VMs the user can still restore, and a
-- reclaim is an irreversible destroy. When their page is finally purged, the
-- trigger captures them then.
INSERT INTO machine_sprite_reclaims ("sandboxId")
SELECT s."sandboxId"
FROM machine_sessions s
JOIN pages p ON p.id = s."pageId"
WHERE p."isTrashed" = true
  AND s."teardownRequestedAt" IS NOT NULL
ON CONFLICT ("sandboxId") DO NOTHING;

INSERT INTO machine_sprite_reclaims ("sandboxId")
SELECT b."sandboxId"
FROM machine_branches b
JOIN pages p ON p.id = b."machineId"
WHERE p."isTrashed" = true
  AND b."teardownRequestedAt" IS NOT NULL
  AND b."spriteTornDownAt" IS NULL
ON CONFLICT ("sandboxId") DO NOTHING;
