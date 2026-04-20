-- Canonical "pages this user can view" function plus its supporting indexes.
-- Resolution rules (mirror getUserAccessLevel + getUserAccessiblePagesInDrive):
--   1. Drive owner — full visibility into every non-trashed page in their non-trashed drives.
--   2. Drive ADMIN member — same, via drive_members.
--   3. Explicit page_permissions row with canView=true and (expiresAt IS NULL OR expiresAt > now()).
-- Trashed drives and trashed pages are excluded.
-- DROP-then-CREATE keeps the migration safely re-runnable in dev/CI snapshots.

DROP FUNCTION IF EXISTS accessible_page_ids_for_user(text);
--> statement-breakpoint
CREATE FUNCTION accessible_page_ids_for_user(uid text)
RETURNS TABLE(page_id text)
LANGUAGE sql
SECURITY DEFINER
STABLE
PARALLEL SAFE
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
