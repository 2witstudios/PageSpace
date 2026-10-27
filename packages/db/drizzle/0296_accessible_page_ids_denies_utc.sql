-- Make accessible_page_ids_for_user agree with getUserAccessLevel
-- (packages/lib/src/permissions/permissions.ts) on denies and on expiry.
--
-- 0133 OR-ed rule 4 ("any accepted member reads a non-private page") in beside
-- the other rules, so it granted pages the TS resolver denies:
--   * a custom role whose per-page entry, or drive-wide default, has canView=false;
--   * an unexpired page_permissions row with canView=false.
-- It also ignored custom roles entirely, so a per-page custom-role grant on a
-- PRIVATE page was missing from the set although the TS resolver allows it.
-- And it compared expiresAt (timestamp WITHOUT time zone, holding UTC wall
-- time) against bare now(), which is reinterpreted in the session's TimeZone:
-- west of UTC an expired grant stayed live, east of UTC a live grant was dead.
--
-- Resolution, first matching rule wins (mirrors getUserAccessLevel exactly):
--   1. Drive owner                                            -> visible.
--   2. Accepted drive_members row with role='ADMIN'           -> visible.
--   3. Unexpired page_permissions row                         -> its canView (a deny is final).
--   4. No accepted membership                                 -> hidden.
--   5. Accepted member whose custom role (same drive) lists this page
--                                                             -> the entry's canView.
--   6. ...whose custom role has a drive-wide default          -> hidden if the page is private,
--                                                                else the default's canView.
--   7. Otherwise                                              -> visible iff the page is not private.
-- Trashed pages and pages in trashed drives are still excluded up front; the
-- function stays stricter than the TS helpers there (see 0102).
--
-- Drizzle cannot express a function, so this is a custom migration created by
-- `drizzle-kit generate --custom`, and it follows 0102/0133: DROP-then-CREATE,
-- SECURITY DEFINER with a pinned search_path.

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
  JOIN drives d
    ON d.id = p."driveId"
   AND d."isTrashed" = false
  -- drive_members is unique on (driveId, userId) and page_permissions on
  -- (pageId, userId), so none of these joins can duplicate a page.
  LEFT JOIN drive_members dm
    ON dm."driveId" = p."driveId"
   AND dm."userId" = uid
   AND dm."acceptedAt" IS NOT NULL
  LEFT JOIN page_permissions pp
    ON pp."pageId" = p.id
   AND pp."userId" = uid
   AND (pp."expiresAt" IS NULL OR pp."expiresAt" > (now() at time zone 'utc'))
  LEFT JOIN drive_roles dr
    ON dr.id = dm."customRoleId"
   AND dr."driveId" = p."driveId"
  WHERE p."isTrashed" = false
    AND CASE
      WHEN d."ownerId" = uid THEN true
      WHEN dm.role = 'ADMIN' THEN true
      WHEN pp.id IS NOT NULL THEN pp."canView"
      WHEN dm.id IS NULL THEN false
      -- A per-page entry that is JSON null resolves to nothing in TS and falls
      -- through to rule 7, never to the drive-wide default.
      WHEN dr.permissions ? p.id AND jsonb_typeof(dr.permissions -> p.id) <> 'null'
        THEN coalesce((dr.permissions -> p.id -> 'canView') = 'true'::jsonb, false)
      WHEN NOT (dr.permissions ? p.id)
       AND dr.drive_wide_permissions IS NOT NULL
       AND jsonb_typeof(dr.drive_wide_permissions) <> 'null'
        THEN NOT p."isPrivate"
         AND coalesce((dr.drive_wide_permissions -> 'canView') = 'true'::jsonb, false)
      ELSE NOT p."isPrivate"
    END;
$$;
