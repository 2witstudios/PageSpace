import { db } from '@pagespace/db/db';
import { sql } from '@pagespace/db/operators';

/**
 * Returns the set of page IDs the given user can view, computed via the
 * canonical `accessible_page_ids_for_user` Postgres function.
 *
 * The function is the SQL twin of `getUserAccessLevel`'s canView decision —
 * owner, drive admin, explicit page permission (a deny is final), custom role,
 * then accepted member on a non-private page; current definition in
 * `drizzle/0296_accessible_page_ids_denies_utc.sql`, and
 * accessible-page-ids-agreement.integration.test.ts holds the two together.
 * Trashed pages and pages in trashed drives are excluded; expired explicit
 * grants (compared in UTC) are excluded.
 */
export async function accessiblePageIds(userId: string): Promise<string[]> {
  if (!userId) return [];
  const result = await db.execute<{ page_id: string }>(
    sql`SELECT page_id FROM accessible_page_ids_for_user(${userId})`,
  );
  return result.rows.map((row) => row.page_id);
}
