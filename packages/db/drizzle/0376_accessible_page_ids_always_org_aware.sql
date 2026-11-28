-- accessible_page_ids_for_user is always org-aware: the ORGS_ENABLED dark-ship
-- switch is gone (organizations are live), so the function drops its
-- orgs_enabled parameter and applies the org rules of 0356 unconditionally.
-- The decision is otherwise exactly 0356's: on a drive with no org it is the
-- plain drive_members decision; on an org drive it is the effective membership
-- (resolveEffectiveDriveMembership), the POL-6 Open-drive floor and the ORG-4
-- org_power_* columns. See 0356 for the full rule list.
--
-- Custom migration (`drizzle-kit generate --custom`), DROP-then-CREATE,
-- SECURITY DEFINER with a pinned search_path, as 0102/0133/0296/0309/0356.

DROP FUNCTION IF EXISTS accessible_page_ids_for_user(text, boolean);
--> statement-breakpoint
DROP FUNCTION IF EXISTS accessible_page_ids_for_user(text);
--> statement-breakpoint
CREATE FUNCTION accessible_page_ids_for_user(uid text)
RETURNS TABLE(page_id text, org_power_drive_id text, org_power_org_id text, org_power_role text)
LANGUAGE sql
SECURITY DEFINER
STABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  SELECT
    p.id,
    CASE WHEN m.org_power_private THEN d.id END,
    CASE WHEN m.org_power_private THEN d."orgId" END,
    CASE WHEN m.org_power_private THEN om.role::text END
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
    ON om."orgId" = d."orgId"
   AND om."userId" = uid
  CROSS JOIN LATERAL (
    SELECT d."orgId" IS NOT NULL AS org_drive
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
        AND (r.row_role IS NULL OR (dm.source = 'org' AND r.row_role = 'MEMBER')) AS floored,
      -- ORG-4: org power (not the user's own ADMIN row, not the lead) opened a PRIVATE drive.
      o.org_drive
        AND d."ownerId" <> uid
        AND om.role IN ('OWNER', 'ADMIN')
        AND r.row_role IS DISTINCT FROM 'ADMIN'
        AND d."orgVisibility" = 'PRIVATE' AS org_power_private
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
