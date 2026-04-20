import { db, sql } from '@pagespace/db';

/**
 * Returns the set of page IDs the given user can view, computed via the
 * canonical `accessible_page_ids_for_user` Postgres function.
 *
 * The function collapses the (owner | drive-admin | explicit-page-permission)
 * authorization graph into one DB-side primitive. Trashed pages and pages in
 * trashed drives are excluded; expired explicit grants are excluded.
 */
export async function accessiblePageIds(userId: string): Promise<string[]> {
  if (!userId) return [];
  const result = await db.execute<{ page_id: string }>(
    sql`SELECT page_id FROM accessible_page_ids_for_user(${userId})`,
  );
  return result.rows.map((row) => row.page_id);
}
