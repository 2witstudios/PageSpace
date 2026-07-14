-- Carry the Sprite INSTANCE id through the reclaim outbox.
--
-- `sandboxId` is only the Sprite's NAME — our own derived session key — and a
-- name is REUSED across re-creates: destroy a Sprite and provision another under
-- the same key and it answers to the same `sandboxId` while being a physically
-- different VM (the codebase already relies on this distinction for the egress
-- lockdown token, which is keyed on the instance id precisely because "a Sprite
-- destroyed and re-created under the same name is a different VM").
--
-- The kill is name-keyed (`deleteSprite(name)`), so a reclaim that carries only a
-- name says "destroy whatever VM currently holds this name" — which, if someone
-- legitimately re-provisioned under it in the meantime, destroys THEIR live VM.
-- Rescuing the instance id alongside the name lets the reconciler pass it as an
-- identity guard: kill the VM at this name ONLY if it is still the one we meant.
-- A row with a NULL instance id (rescued before this column existed) falls back
-- to the name-only kill.

DROP TRIGGER IF EXISTS machine_sessions_sprite_reclaim ON machine_sessions;
DROP TRIGGER IF EXISTS machine_branches_sprite_reclaim ON machine_branches;

-- SECURITY DEFINER + a pinned search_path: this trigger now sits on the critical
-- path of EVERY page/drive/user delete, including Art. 17 erasure. If it ran as
-- the invoker, any role that may DELETE from `pages` but lacks INSERT on the
-- outbox would have its delete FAIL — the one outcome this design must never
-- cause (an erasure blocked by a Sprite we failed to kill). Running as the owner
-- makes the capture unconditional; the pinned search_path keeps a hostile
-- search_path from resolving `machine_sprite_reclaims` to another table.
CREATE OR REPLACE FUNCTION machine_sessions_capture_sprite_reclaim()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- A machine_sessions row exists ONLY while we believe its Sprite is live (it is
  -- deleted on a confirmed kill), so any delete of one is a pointer worth
  -- rescuing. Re-enqueueing a Sprite that was in fact already destroyed is
  -- harmless: the reconciler's kill is idempotent, so the redundant attempt simply
  -- confirms the death and drops the row — which also makes this a safety net
  -- against a teardown that only THOUGHT it succeeded.
  INSERT INTO public.machine_sprite_reclaims ("sandboxId", "spriteInstanceId")
  VALUES (OLD."sandboxId", OLD."spriteInstanceId")
  ON CONFLICT ("sandboxId") DO UPDATE
    -- A newer generation took this name; the pointer must chase the VM that is
    -- actually alive now, not the one a stale row remembers.
    SET "spriteInstanceId" = COALESCE(EXCLUDED."spriteInstanceId", public.machine_sprite_reclaims."spriteInstanceId");
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION machine_branches_capture_sprite_reclaim()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- A branch row OUTLIVES its Sprite on purpose (it is re-creatable config, and
  -- its branch-scoped machine_agent_terminals FK-cascade off it), so teardown
  -- STAMPS `spriteTornDownAt` rather than deleting. A stamped row's Sprite is
  -- already confirmed gone — nothing to reclaim. An UNSTAMPED row being deleted
  -- means its Sprite may still be running.
  IF OLD."spriteTornDownAt" IS NULL THEN
    INSERT INTO public.machine_sprite_reclaims ("sandboxId", "spriteInstanceId")
    VALUES (OLD."sandboxId", OLD."spriteInstanceId")
    ON CONFLICT ("sandboxId") DO UPDATE
      SET "spriteInstanceId" = COALESCE(EXCLUDED."spriteInstanceId", public.machine_sprite_reclaims."spriteInstanceId");
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER machine_sessions_sprite_reclaim
  AFTER DELETE ON machine_sessions
  FOR EACH ROW
  EXECUTE FUNCTION machine_sessions_capture_sprite_reclaim();

CREATE TRIGGER machine_branches_sprite_reclaim
  AFTER DELETE ON machine_branches
  FOR EACH ROW
  EXECUTE FUNCTION machine_branches_capture_sprite_reclaim();
