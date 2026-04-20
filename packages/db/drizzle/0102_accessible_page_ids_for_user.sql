-- Canonical "pages this user can view" function plus its supporting indexes.
--
-- Resolution rules (a user sees a page iff ANY of the following holds):
--   1. They own the drive that contains the page.
--   2. They are a drive_members row with role='ADMIN' AND acceptedAt IS NOT NULL
--      (pending invites do NOT grant page visibility).
--   3. They have a page_permissions row with canView=true and either
--      expiresAt IS NULL or expiresAt > now().
--
-- This function is STRICTER than the equivalent TS helpers it replaces
-- (getUserAccessLevel / getUserAccessiblePagesInDrive): it excludes trashed
-- pages and pages inside trashed drives. Those helpers return trashed rows
-- and rely on callers to filter. The one-fetch payload assumes the DB has
-- already filtered, which is why this tightening lives here.
--
-- SECURITY DEFINER is scoped by `SET search_path = pg_catalog, public` so a
-- role with CREATE on another schema cannot shadow symbols like now().
--
-- DROP-then-CREATE keeps the migration safely re-runnable in dev/CI snapshots.

DROP FUNCTION IF EXISTS accessible_page_ids_for_user(text);
--> statement-breakpoint
CREATE FUNCTION accessible_page_ids_for_user(uid text)
RETURNS TABLE(page_id text)
LANGUAGE sql
SECURITY DEFINER
STABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  SELECT p.id
  FROM pages p
  WHERE p."isTrashed" = false
    AND EXISTS (
      SELECT 1 FROM drives d
      WHERE d.id = p."driveId"
        AND d."isTrashed" = false
        AND (
          d."ownerId" = uid
          OR EXISTS (
            SELECT 1 FROM drive_members dm
            WHERE dm."driveId" = d.id
              AND dm."userId" = uid
              AND dm.role = 'ADMIN'
              AND dm."acceptedAt" IS NOT NULL
          )
          OR EXISTS (
            SELECT 1 FROM page_permissions pp
            WHERE pp."pageId" = p.id
              AND pp."userId" = uid
              AND pp."canView" = true
              AND (pp."expiresAt" IS NULL OR pp."expiresAt" > now())
          )
        )
    );
$$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "drives_owner_id_active_idx"
  ON "drives" ("ownerId")
  WHERE "isTrashed" = false;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "drive_members_drive_user_role_accepted_idx"
  ON "drive_members" ("driveId", "userId", "role", "acceptedAt");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "page_permissions_user_page_covering_idx"
  ON "page_permissions" ("userId", "pageId")
  INCLUDE ("canView", "canEdit", "canShare", "canDelete", "expiresAt");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pages_drive_id_active_idx"
  ON "pages" ("driveId")
  WHERE "isTrashed" = false;
