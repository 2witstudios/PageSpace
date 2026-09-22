-- Custom SQL migration file, put your code below! --

-- Epic "Sign in with PageSpace", Phase 4 (ADR 0004 Decision 12; PR #2711) —
-- retire an environment's platform-managed OAuth client when the env row dies.
--
-- Every drive environment IS an OAuth client: `oauth_clients."clientId"` =
-- 'env_' || drive_envs.id, provisioned by the platform, redirecting to the
-- env's preview and published origins. `oauth_clients` has NO foreign key to
-- `drive_envs` (the client outlives its owner only until an operator disables
-- it; token rows FK to the client), so nothing in the schema retires the
-- client when the env goes — and an env row goes by MORE paths than the env
-- DELETE route: a permanent drive delete (`drive_envs."driveId"` → `drives`,
-- CASCADE), the account-erasure worker, the trash purge. The app-level retire
-- on the env DELETE route (`retireEnvOAuthClientForEnv`) never runs for any
-- of those (Codex, PR #2711, P1).
--
-- WHY A TRIGGER AND NOT A GUARD ON THE DELETE PATHS: 0263's argument, verbatim
-- in spirit — guarding each path is unenforceable (there is always one more),
-- and Art. 17 erasure must not be blocked by a client we failed to disable.
-- Postgres fires row triggers for rows deleted by a referential CASCADE too, so
-- this single AFTER DELETE covers every path, and the writes ride the deleting
-- transaction: either the client is disabled and its families revoked, or the
-- delete does not commit.
--
-- What "retire" means, matching `revokeOAuthFamiliesForClient` /
-- `createDbEnvOAuthClientStore.disable` in apps/web exactly: stamp
-- `disabledAt` (once), then revoke every live refresh AND access token of the
-- client with reason 'client_disabled'. `disabledAt` alone only stops NEW
-- grants (`resolveClient` filters it, and `validateOAuthAccessToken` refuses a
-- disabled client's access tokens on sight); the refresh families are what
-- would otherwise outlive the env for up to 90 days.
--
-- UTC by construction: these are `timestamp` columns storing UTC, and `now()`
-- resolves through the session time zone — so `(now() at time zone 'utc')`,
-- never bare `now()`.
--
-- SECURITY DEFINER + a pinned search_path for the same reason as 0263: this
-- sits on the critical path of every drive delete, including Art. 17 erasure,
-- and a role allowed to DELETE from `drives` but lacking UPDATE on the OAuth
-- tables must never have its delete fail.
CREATE OR REPLACE FUNCTION drive_envs_retire_oauth_client()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  retired_at timestamp := (now() at time zone 'utc');
BEGIN
  UPDATE public.oauth_clients
     SET "disabledAt" = retired_at
   WHERE "clientId" = 'env_' || OLD.id
     AND "disabledAt" IS NULL;

  UPDATE public.oauth_refresh_tokens
     SET "revokedAt" = retired_at, "revokedReason" = 'client_disabled'
   WHERE "revokedAt" IS NULL
     AND "clientId" IN (SELECT id FROM public.oauth_clients WHERE "clientId" = 'env_' || OLD.id);

  UPDATE public.oauth_access_tokens
     SET "revokedAt" = retired_at, "revokedReason" = 'client_disabled'
   WHERE "revokedAt" IS NULL
     AND "clientId" IN (SELECT id FROM public.oauth_clients WHERE "clientId" = 'env_' || OLD.id);

  RETURN OLD;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS drive_envs_retire_oauth_client ON drive_envs;--> statement-breakpoint

-- No WHEN clause: every env may hold a client (the platform provisions one on
-- create, and a sync on first preview or publish provisions one for an env
-- that predates this phase), and an env with no client row updates zero rows.
CREATE TRIGGER drive_envs_retire_oauth_client
  AFTER DELETE ON drive_envs
  FOR EACH ROW
  EXECUTE FUNCTION drive_envs_retire_oauth_client();

-- No backfill: no env client row exists before this phase ships, and every
-- env deleted from here on passes through this trigger.
