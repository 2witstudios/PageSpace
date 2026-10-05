import { db } from '@pagespace/db/db';
import { sql, type SQL } from '@pagespace/db/operators';
import { ORGS_ENABLED } from '../organizations/orgs-enabled';
import type { OrgRole } from '@pagespace/db/schema/organizations';
import { auditOrgAdminPrivateDriveAccess } from './org-admin-access-audit';

/**
 * The canonical page-visibility set as a FROM-able SQL fragment, for every query that reads it
 * (accessiblePageIds, page payloads, breadcrumbs). The org rules (org Owner/Admin power, implicit
 * Open-drive membership with the POL-6 floor, stale org rows counting for nothing) switch on with
 * ORGS_ENABLED, exactly as they do in getUserAccessLevel; dark, the function is the pre-org decision.
 */
export function accessiblePageIdsSource(userId: string): SQL {
  return sql`accessible_page_ids_for_user(${userId}, ${ORGS_ENABLED})`;
}

/**
 * Returns the set of page IDs the given user can view, computed via the
 * canonical `accessible_page_ids_for_user` Postgres function.
 *
 * The function is the SQL twin of `getUserAccessLevel`'s canView decision —
 * owner, drive admin, explicit page permission (a deny is final), custom role,
 * then accepted member on a non-private page, and (while ORGS_ENABLED) the org-aware membership
 * and the POL-6 Open-drive floor; current definition in
 * `drizzle/0334_accessible_page_ids_org_aware.sql`, and
 * accessible-page-ids-agreement.integration.test.ts holds the two together.
 * Trashed pages and pages in trashed drives are excluded; expired explicit
 * grants (compared in UTC) are excluded.
 */
export async function accessiblePageIds(userId: string): Promise<string[]> {
  if (!userId) return [];
  const result = await db.execute<OrgPowerRow & { page_id: string }>(
    sql`SELECT page_id, org_power_drive_id, org_power_org_id, org_power_role FROM ${accessiblePageIdsSource(userId)}`,
  );
  auditOrgPowerAccess(userId, result.rows);
  return result.rows.map((row) => row.page_id);
}

/** The function's ORG-4 columns: set only when org Owner/Admin power opened a PRIVATE drive's page. */
export type OrgPowerRow = {
  org_power_drive_id: string | null;
  org_power_org_id: string | null;
  org_power_role: string | null;
};

/**
 * ORG-4: the user's own request read pages through org power on a PRIVATE drive, so write the same event
 * getUserAccessLevel writes, once per drive (auditOrgAdminPrivateDriveAccess dedupes per window).
 */
export function auditOrgPowerAccess(userId: string, rows: readonly OrgPowerRow[]): void {
  const audited = new Set<string>();
  for (const { org_power_drive_id: driveId, org_power_org_id: orgId, org_power_role: orgRole } of rows) {
    if (!driveId || !orgId || !isOrgRole(orgRole) || audited.has(driveId)) continue;
    audited.add(driveId);
    void auditOrgAdminPrivateDriveAccess({ userId, driveId, orgId, orgRole });
  }
}

const isOrgRole = (role: string | null): role is OrgRole => role === 'OWNER' || role === 'ADMIN' || role === 'MEMBER';
