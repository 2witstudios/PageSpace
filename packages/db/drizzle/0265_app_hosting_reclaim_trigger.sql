-- Custom SQL migration file, put your code below! --

-- App hosting reclaim trigger — make the pointer to a live, billing Fly app UNKILLABLE.
--
-- A published app is a real Fly app that bills for as long as it exists. The only
-- way to find one is its `flyAppName`, and that name lives on `published_apps`,
-- which FK-cascades off `drive_envs.id` AND `drives.id` (and through them off
-- `users.id`). So EVERY hard delete of an environment or a drive destroys the only
-- pointer to an app that may still be serving: deleting an env, a permanent drive
-- delete, the 30-day GDPR purge, the account-erasure worker — and any path added in
-- the future. The app then bills forever, unreachable from inside the product. This is not hypothetical: the Sprites equivalent of exactly this bug put
-- a stuck, unreferenced microVM into production that had to be killed by hand
-- (see 0209_sprite_reclaim_triggers.sql, whose design this migration copies).
--
-- Guarding each delete path is unenforceable (there is always one more), and it
-- cannot work for erasure: GDPR Art. 17 must never be blocked by a Fly app we
-- failed to kill. So we do not guard the deletes — we rescue the pointer.
--
-- ONE trigger, on `published_apps` itself, is sufficient and is strictly safer than
-- also putting triggers on `drive_envs`/`drives`. Postgres fires row-level triggers
-- for rows deleted by a referential CASCADE exactly as it does for a direct DELETE,
-- so a `DELETE FROM drive_envs`, a `DELETE FROM drives`, a user erasure cascading
-- through both, and a hand-run `DELETE FROM published_apps` in psql all arrive here
-- with the full OLD row — `flyAppName` included. A trigger on `drive_envs` or
-- `drives` could not do better: those rows do not carry `flyAppName`, so it would
-- have to re-query `published_apps` in the middle of the very cascade that is
-- deleting it.
--
-- This is also why the two reclaim outboxes stay partitioned. `drive_envs` carries
-- SPRITE pointers, rescued by its own trigger into `machine_sprite_reclaims`
-- (0263); a Fly app name never appears on that row, so nothing there could kill
-- one. Deleting an env therefore fires both triggers — its own for the Sprite, this
-- one for the Fly app — and each pointer lands in the outbox whose drain cron can
-- actually destroy the resource it names.
--
-- The INSERT runs inside the deleting transaction: either the pointer moves, or the
-- delete does not commit. The pointer therefore OUTLIVES the resource.
--
-- BOTH identifiers are rescued and the machine id is the identity guard. The kill is
-- NAME-keyed (destroy the Fly app called `pgs-app-<id>`), and while our names are
-- derived from a cuid2 and so are not expected to recur, a reclaim carrying only a
-- name says "destroy whatever app currently holds this name". With `machineId` the
-- drain cron can say instead: destroy the app at this name ONLY if it is still the
-- one we meant. NULL means the app never had a machine, so the destroy is
-- unambiguous — there is nothing running to protect.
--
-- The drain cron (epic Phase 5) removes a row only once the Fly app is CONFIRMED
-- gone, so a failed kill is retried forever instead of being forgotten.

DROP TRIGGER IF EXISTS published_apps_hosting_reclaim ON published_apps;
--> statement-breakpoint

-- SECURITY DEFINER + a pinned search_path: this trigger now sits on the critical
-- path of EVERY env/drive/user delete, including Art. 17 erasure. If it ran as the
-- invoker, any role that may DELETE from `pages` but lacks INSERT on the outbox
-- would have its delete FAIL — the one outcome this design must never cause (an
-- erasure blocked by a Fly app we failed to kill). Running as the owner makes the
-- capture unconditional; the pinned search_path keeps a hostile search_path from
-- resolving `app_hosting_reclaims` to another table.
CREATE OR REPLACE FUNCTION published_apps_capture_hosting_reclaim()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- A `published_apps` row exists only while we believe its Fly app does, so any
  -- delete of one is a pointer worth rescuing. Re-enqueueing an app that was in fact
  -- already destroyed is harmless: the drain cron's kill is idempotent, so the
  -- redundant attempt simply confirms the death and drops the row — which also makes
  -- this a safety net against a teardown that only THOUGHT it succeeded.
  INSERT INTO public.app_hosting_reclaims ("flyAppName", "publishedAppId", "machineId")
  VALUES (OLD."flyAppName", OLD."id", OLD."machineId")
  ON CONFLICT ("flyAppName") DO UPDATE
    -- A newer row took this name; the pointer must chase the machine that is
    -- actually alive now, not the one a stale row remembers.
    SET "publishedAppId" = EXCLUDED."publishedAppId",
        "machineId" = COALESCE(EXCLUDED."machineId", public.app_hosting_reclaims."machineId");
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER published_apps_hosting_reclaim
  AFTER DELETE ON published_apps
  FOR EACH ROW
  EXECUTE FUNCTION published_apps_capture_hosting_reclaim();
