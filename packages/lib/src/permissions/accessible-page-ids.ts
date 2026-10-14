import { db } from '@pagespace/db/db';
import { sql } from '@pagespace/db/operators';
import type { OrgRole } from '@pagespace/db/schema/organizations';
import { auditOrgAdminPrivateDriveAccess } from './org-admin-access-audit';
import { accessiblePageIdsSource } from './accessible-page-ids-source';
import type { AccessActor } from './access-actor';
import { dropWithheldDerivedPages, filterDrivesForActor } from './actor-authentication';

/**
 * Returns the set of page IDs the actor can view, computed via the
 * canonical `accessible_page_ids_for_user` Postgres function.
 *
 * The function is the SQL twin of `getUserAccessLevel`'s canView decision —
 * owner, drive admin, explicit page permission (a deny is final), custom role,
 * then accepted member on a non-private page, and the org-aware membership
 * and the POL-6 Open-drive floor; current definition in
 * `drizzle/0376_accessible_page_ids_always_org_aware.sql`, and
 * accessible-page-ids-agreement.integration.test.ts holds the two together.
 * Trashed pages and pages in trashed drives are excluded; expired explicit
 * grants (compared in UTC) are excluded.
 *
 * SEC-2/3 (D-OW-45): the function knows nothing of the credential, so the pages of every org drive
 * whose sign-in policy the actor's credential fails are dropped here, as getUserAccessLevel drops them, and so are
 * pages restating org-derived content (memory pages, D-OW-62) a contributing org withholds from the credential.
 * Org power is audited only for the pages that survive.
 */
export async function accessiblePageIds(actor: AccessActor): Promise<string[]> {
  if (!actor.userId) return [];
  const result = await db.execute<OrgPowerRow & { page_id: string; drive_id: string }>(
    sql`SELECT a.page_id, p."driveId" AS drive_id, a.org_power_drive_id, a.org_power_org_id, a.org_power_role
        FROM ${accessiblePageIdsSource(actor.userId)} a
        JOIN pages p ON p.id = a.page_id`,
  );
  const allowedDrives = await filterDrivesForActor(actor, [...new Set(result.rows.map((row) => row.drive_id))]);
  const rows = result.rows.filter((row) => allowedDrives.has(row.drive_id));
  auditOrgPowerAccess(actor.userId, rows);
  // D-OW-62: a page restating org-derived content (a memory page) is withheld from a credential its orgs refuse.
  return dropWithheldDerivedPages(actor, rows.map((row) => row.page_id));
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
