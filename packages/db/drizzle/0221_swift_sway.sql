-- Drop the dormant legacy `permissions` table (#2160, sources-of-truth audit).
--
-- The action-enum `permissions` table (id / action / subjectType / subjectId /
-- pageId) has existed since "Open Beta Init" and has never had a single reader
-- or writer: every live permission check goes through `page_permissions`
-- (schema/members.ts) via packages/lib/src/permissions/. A dormant permissions
-- table is worse than dead code — any residual rows are frozen misinformation
-- about access control, and its presence in the combined schema object invites
-- a future query against the wrong source.
--
-- drizzle-kit 0.23 emits the DROP TABLE but not the DROP TYPE for the two enums
-- only this table used, so those are appended by hand (precedent:
-- 0105_drop_password_auth_enums.sql, 0116_colossal_tattoo.sql).
--
-- The RAISE NOTICE records the row count in the deploy log before the data is
-- gone — the drop stays unconditional and the deploy never blocks, but the
-- number is preserved. Guard and drops share ONE DO block: psql's default
-- ON_ERROR_STOP=off reports a failed statement and CONTINUES, so a count taken
-- as its own statement would prove nothing about what followed it.

DO $$
DECLARE legacy_row_count bigint := -1;
BEGIN
  IF to_regclass('public.permissions') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.permissions' INTO legacy_row_count;
  END IF;
  RAISE NOTICE '#2160: dropping legacy permissions table (rows = %, -1 means already absent)', legacy_row_count;

  DROP TABLE IF EXISTS "public"."permissions";
  DROP TYPE IF EXISTS "public"."PermissionAction";
  DROP TYPE IF EXISTS "public"."SubjectType";
END $$;
