import { db } from '@pagespace/db/db';
import { sql, type SQL } from '@pagespace/db/operators';
import { ORGS_ENABLED } from '../organizations/orgs-enabled';

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
  const result = await db.execute<{ page_id: string }>(
    sql`SELECT page_id FROM ${accessiblePageIdsSource(userId)}`,
  );
  return result.rows.map((row) => row.page_id);
}
