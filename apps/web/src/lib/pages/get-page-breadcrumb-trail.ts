import { db } from '@pagespace/db/db';
import { sql } from '@pagespace/db/operators';
import { pages, drives } from '@pagespace/db/schema/core';
import type { PageTypeValue } from '@pagespace/lib/utils/enums';

export interface BreadcrumbPage {
  id: string;
  title: string;
  type: PageTypeValue;
  parentId: string | null;
  driveId: string;
  drive: { id: string; slug: string; name: string } | null;
}

type QueryResultRow = {
  id: string;
  title: string;
  type: PageTypeValue;
  driveId: string;
  parentId: string | null;
  drive_id: string | null;
  drive_slug: string | null;
  drive_name: string | null;
  depth: number;
};

/**
 * Ancestor trail for a page, root-first, via a single recursive-CTE query.
 * Shared by `/api/pages/[pageId]/breadcrumbs` (the UI breadcrumb bar) and the
 * AI request-context resolver (`resolve-request-context.ts`) — one source of
 * truth for "what is this page's path" instead of two independent walks.
 *
 * Callers own their own authorization check; this function trusts `pageId` and
 * performs no permission filtering.
 */
export async function getPageBreadcrumbTrail(pageId: string): Promise<BreadcrumbPage[]> {
  const MAX_DEPTH = 100;

  const result = await db.execute<QueryResultRow>(sql`
    WITH RECURSIVE page_ancestors AS (
      -- Base case: start with the requested page
      SELECT
        p.id,
        p.title,
        p.type,
        p."driveId",
        p."parentId",
        d.id as drive_id,
        d.slug as drive_slug,
        d.name as drive_name,
        1 as depth,
        ARRAY[p.id] as path
      FROM ${pages} p
      LEFT JOIN ${drives} d ON p."driveId" = d.id
      WHERE p.id = ${pageId}

      UNION ALL

      -- Recursive case: get parent pages
      SELECT
        p.id,
        p.title,
        p.type,
        p."driveId",
        p."parentId",
        d.id as drive_id,
        d.slug as drive_slug,
        d.name as drive_name,
        pa.depth + 1,
        pa.path || p.id
      FROM ${pages} p
      LEFT JOIN ${drives} d ON p."driveId" = d.id
      INNER JOIN page_ancestors pa ON p.id = pa."parentId"
      WHERE
        pa.depth < ${MAX_DEPTH}
        AND NOT (p.id = ANY(pa.path))  -- Cycle detection
    )
    SELECT id, title, type, "driveId", "parentId", drive_id, drive_slug, drive_name, depth
    FROM page_ancestors
    ORDER BY depth DESC
  `);

  return result.rows.map((row: QueryResultRow): BreadcrumbPage => ({
    id: row.id,
    title: row.title,
    type: row.type,
    driveId: row.driveId,
    parentId: row.parentId,
    drive: row.drive_id && row.drive_slug && row.drive_name ? {
      id: row.drive_id,
      slug: row.drive_slug,
      name: row.drive_name,
    } : null,
  }));
}
