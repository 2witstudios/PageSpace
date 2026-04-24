import { NextResponse } from 'next/server';
import { canUserViewPage } from '@pagespace/lib/permissions/permissions'
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db } from '@pagespace/db/db'
import { sql } from '@pagespace/db/operators'
import { pages, drives } from '@pagespace/db/schema/core';

interface BreadcrumbPage {
  id: string;
  title: string;
  type: 'FOLDER' | 'DOCUMENT' | 'CHANNEL' | 'AI_CHAT' | 'CANVAS' | 'FILE' | 'SHEET' | 'TASK_LIST' | 'CODE';
  parentId: string | null;
  driveId: string;
  drive: { id: string; slug: string; name: string } | null;
}

type QueryResultRow = {
  id: string;
  title: string;
  type: 'FOLDER' | 'DOCUMENT' | 'CHANNEL' | 'AI_CHAT' | 'CANVAS' | 'FILE' | 'SHEET' | 'TASK_LIST' | 'CODE';
  driveId: string;
  parentId: string | null;
  drive_id: string | null;
  drive_slug: string | null;
  drive_name: string | null;
  depth: number;
};

async function getBreadcrumbs(pageId: string): Promise<BreadcrumbPage[]> {
  const MAX_DEPTH = 100;

  // Use recursive CTE to fetch all ancestors in a single query
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

  // Transform the result to match BreadcrumbPage type
  const breadcrumbs: BreadcrumbPage[] = result.rows.map((row: QueryResultRow): BreadcrumbPage => ({
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

  return breadcrumbs;
}

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: false } as const;

export async function GET(req: Request, { params }: { params: Promise<{ pageId: string }> }) {
  const { pageId } = await params;

  // Support both Bearer tokens (desktop) and cookies (web)
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }

  const canView = await canUserViewPage(auth.userId, pageId);
  if (!canView) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const breadcrumbs = await getBreadcrumbs(pageId);

  auditRequest(req, { eventType: 'data.read', userId: auth.userId, resourceType: 'page_breadcrumb', resourceId: pageId, details: { action: 'get_breadcrumbs', depth: breadcrumbs.length } });

  return NextResponse.json(breadcrumbs);
}
