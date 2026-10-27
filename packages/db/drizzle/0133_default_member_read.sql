-- Update accessible_page_ids_for_user to implement Discord-style open-by-default
-- within a drive. Rule 4 (new): an accepted drive member can read any page in
-- that drive unless the page is explicitly marked isPrivate=true.
--
-- Resolution rules (a user sees a page iff ANY of the following holds):
--   1. They own the drive that contains the page.
--   2. They are a drive_members row with role='ADMIN' AND acceptedAt IS NOT NULL.
--   3. They have a page_permissions row with canView=true and either
--      expiresAt IS NULL or expiresAt > now().
--   4. They are any accepted drive member AND page.isPrivate=false.
--      (Drive MEMBER role gets implicit read on non-private pages.)

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
          OR (
            p."isPrivate" = false
            AND EXISTS (
              SELECT 1 FROM drive_members dm
              WHERE dm."driveId" = d.id
                AND dm."userId" = uid
                AND dm."acceptedAt" IS NOT NULL
            )
          )
        )
    );
$$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pages_is_private_drive_id_idx"
  ON "pages" ("driveId", "isPrivate")
  WHERE "isTrashed" = false;
