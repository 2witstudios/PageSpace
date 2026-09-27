-- Exclude GUEST drive members from every drive-wide rule of
-- accessible_page_ids_for_user, so it keeps agreeing with getUserAccessLevel
-- (packages/lib/src/permissions/permissions.ts).
--
-- 0308 added 'GUEST' to "MemberRole": the row redeemPageShareLink creates. A
-- guest was given one page (via its page_permissions grant), not the drive, so
-- only rules 1-3 of 0296 may apply to them. Before this, the membership row the
-- redeem inserted fell through to rule 7 and made every non-private page of the
-- drive visible.
--
-- Resolution, first matching rule wins (mirrors getUserAccessLevel exactly):
--   1. Drive owner                                            -> visible.
--   2. Accepted drive_members row with role='ADMIN'           -> visible.
--   3. Unexpired page_permissions row                         -> its canView (a deny is final).
--   4. No accepted membership                                 -> hidden.
--   4a. Accepted membership with role='GUEST'                 -> hidden.
--   5. Accepted member whose custom role (same drive) lists this page
--                                                             -> the entry's canView.
--   6. ...whose custom role has a drive-wide default          -> hidden if the page is private,
--                                                                else the default's canView.
--   7. Otherwise                                              -> visible iff the page is not private.
--
-- A separate migration from 0308 on purpose: the runner applies each migration
-- in its own transaction, and a value added by ALTER TYPE ... ADD VALUE cannot
-- be used in the transaction that added it.
--
-- Custom migration (`drizzle-kit generate --custom`), DROP-then-CREATE,
-- SECURITY DEFINER with a pinned search_path, as 0102/0133/0296.

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
      -- A GUEST row (a redeemed page share link) carries only the explicit
      -- grants above: no custom role, no rule-4 read of the rest of the drive.
      WHEN dm.role = 'GUEST' THEN false
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
