-- accessible_page_ids_for_user becomes org-aware, so it keeps agreeing with
-- getUserAccessLevel (packages/lib/src/permissions/permissions.ts) once
-- ORGS_ENABLED is on (Spec ORG-4, DRV-5..8, POL-6, X-6; lane ow-pol6-resolver).
--
-- Before this, the function read drive_members rows only. On an org drive it
-- gave an org Owner/Admin nothing, gave an implicit Open-drive member nothing,
-- ignored the POL-6 floor, and let a STALE source='org' row (left on a drive
-- that is no longer OPEN) open a RESTRICTED or PRIVATE drive's pages in pulse,
-- the activity summary and page payloads while every TypeScript resolver
-- refused them.
--
-- The org rules apply only when the caller passes orgs_enabled = true (the TS
-- wrapper passes ORGS_ENABLED; the default is false). Dark, or on a drive with
-- no org, the decision is exactly 0309's, so the function can never disagree
-- with the dark resolvers.
--
-- The effective membership on an org drive (resolveEffectiveDriveMembership):
--   - The accepted row counts unless it is a GUEST row (no membership), a
--     former lead's OWNER row (the lead lives on drives.ownerId), or a
--     source='org' row whose holder is no longer in the org or whose drive is
--     no longer OPEN (stale). A pending invitation is no row (acceptedAt).
--   - Org OWNER/ADMIN: ADMIN on every visibility (ORG-4).
--   - Org MEMBER: the counting row; with none, an OPEN drive's default custom
--     role (lowest position, then id), implicitly (DRV-5); else nothing.
--   - Not in the org: the counting row only (a guest, DRV-8).
-- POL-6: an org MEMBER whose OPEN-drive membership is the org's (no row, or a
-- source='org' MEMBER row) sees every non-private page, whatever a role or an
-- explicit grant says (applyOpenDriveFloor; every floor grants view). Private
-- pages stay explicit-only.
--
-- Resolution, first matching rule wins (mirrors getUserAccessLevel):
--   1. Drive owner                                         -> visible.
--   2. Effective role ADMIN                                -> visible.
--   3. POL-6 floor governs and the page is not private     -> visible.
--   4. Unexpired page_permissions row                      -> its canView.
--   5. No effective membership, or a GUEST row (dark)      -> hidden.
--   6. Custom role (same drive) lists this page            -> the entry's canView.
--   7. ...custom role has a drive-wide default             -> hidden if private, else its canView.
--   8. Otherwise                                           -> visible iff not private.
--
-- Custom migration (`drizzle-kit generate --custom`), DROP-then-CREATE,
-- SECURITY DEFINER with a pinned search_path, as 0102/0133/0296/0309. The old
-- one-argument signature is dropped; a one-argument call still resolves (the
-- new parameter has a default) and means dark.

DROP FUNCTION IF EXISTS accessible_page_ids_for_user(text);
--> statement-breakpoint
DROP FUNCTION IF EXISTS accessible_page_ids_for_user(text, boolean);
--> statement-breakpoint
CREATE FUNCTION accessible_page_ids_for_user(uid text, orgs_enabled boolean DEFAULT false)
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
  -- drive_members is unique on (driveId, userId), page_permissions on
  -- (pageId, userId) and org_members on (orgId, userId), so none of these
  -- joins can duplicate a page.
  LEFT JOIN drive_members dm
    ON dm."driveId" = p."driveId"
   AND dm."userId" = uid
   AND dm."acceptedAt" IS NOT NULL
  LEFT JOIN page_permissions pp
    ON pp."pageId" = p.id
   AND pp."userId" = uid
   AND (pp."expiresAt" IS NULL OR pp."expiresAt" > (now() at time zone 'utc'))
  LEFT JOIN org_members om
    ON orgs_enabled
   AND om."orgId" = d."orgId"
   AND om."userId" = uid
  CROSS JOIN LATERAL (
    SELECT orgs_enabled AND d."orgId" IS NOT NULL AS org_drive
  ) o
  -- The accepted row that still counts (validOrgDriveRow); off an org drive, the row as is.
  CROSS JOIN LATERAL (
    SELECT CASE
      WHEN dm.id IS NULL THEN NULL
      WHEN NOT o.org_drive THEN dm.role::text
      WHEN dm.role IN ('GUEST', 'OWNER') THEN NULL
      WHEN dm.source = 'org' AND (om."userId" IS NULL OR d."orgVisibility" <> 'OPEN') THEN NULL
      ELSE dm.role::text
    END AS row_role
  ) r
  -- The effective membership (resolveEffectiveDriveMembership).
  CROSS JOIN LATERAL (
    SELECT
      CASE
        WHEN NOT o.org_drive THEN r.row_role
        WHEN om.role IN ('OWNER', 'ADMIN') THEN 'ADMIN'
        WHEN om.role = 'MEMBER' AND r.row_role IS NULL AND d."orgVisibility" = 'OPEN' THEN 'MEMBER'
        ELSE r.row_role
      END AS role,
      CASE
        WHEN r.row_role IS NOT NULL THEN dm."customRoleId"
        WHEN o.org_drive AND om.role = 'MEMBER' AND d."orgVisibility" = 'OPEN' THEN (
          SELECT dflt.id FROM drive_roles dflt
          WHERE dflt."driveId" = d.id AND dflt."isDefault" = true
          ORDER BY dflt.position, dflt.id
          LIMIT 1
        )
      END AS custom_role_id,
      o.org_drive
        AND om.role = 'MEMBER'
        AND d."orgVisibility" = 'OPEN'
        AND (r.row_role IS NULL OR (dm.source = 'org' AND r.row_role = 'MEMBER')) AS floored
  ) m
  LEFT JOIN drive_roles dr
    ON dr.id = m.custom_role_id
   AND dr."driveId" = p."driveId"
  WHERE p."isTrashed" = false
    AND CASE
      WHEN d."ownerId" = uid THEN true
      WHEN m.role = 'ADMIN' THEN true
      -- POL-6: the org's floor under an implicit Open-drive membership (every floor grants view).
      WHEN m.floored AND NOT p."isPrivate" THEN true
      WHEN pp.id IS NOT NULL THEN pp."canView"
      WHEN m.role IS NULL THEN false
      -- A GUEST row (a redeemed page share link) carries only the explicit
      -- grants above: no custom role, no rule-8 read of the rest of the drive.
      WHEN m.role = 'GUEST' THEN false
      -- A per-page entry that is JSON null resolves to nothing in TS and falls
      -- through to rule 8, never to the drive-wide default.
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
