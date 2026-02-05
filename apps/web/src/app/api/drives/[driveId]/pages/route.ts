import { NextRequest, NextResponse } from 'next/server';
import { buildTree } from '@pagespace/lib/server';
import { pages, drives, pagePermissions, driveMembers, taskItems, db, and, eq, inArray, asc, sql, isNotNull } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError, checkMCPDriveScope } from '@/lib/auth';
import { jsonResponse } from '@pagespace/lib/api-utils';

const AUTH_OPTIONS = { allow: ['session', 'mcp'] as const, requireCSRF: false };

// Cutoff date for unread indicators on never-viewed pages
// For pages the user has never viewed, only show as unread if there's activity after this date
// This prevents overwhelming users with indicators on old content they've never seen
const UNREAD_INDICATOR_CUTOFF_DATE = new Date('2026-02-03T00:00:00.000Z');

async function getPermittedPages(driveId: string, userId: string) {
  // Check if user is a drive member - currently unused but will be needed for member-level permissions
  // const membership = await db.query.driveMembers.findFirst({
  //   where: and(
  //     eq(driveMembers.driveId, driveId),
  //     eq(driveMembers.userId, userId)
  //   )
  // });

  // Get pages user has explicit permissions for
  const permittedPageIdsQuery = await db.selectDistinct({ id: pages.id })
    .from(pages)
    .leftJoin(pagePermissions, eq(pages.id, pagePermissions.pageId))
    .where(and(
      eq(pages.driveId, driveId),
      eq(pages.isTrashed, false),
      eq(pagePermissions.userId, userId),
      eq(pagePermissions.canView, true)
    ));
  const permittedPageIds = permittedPageIdsQuery.map(p => p.id);

  if (permittedPageIds.length === 0) {
    return [];
  }

  // If user has any permissions, also get ancestor pages for tree structure
  let ancestorIds: string[] = [];
  if (permittedPageIds.length > 0) {
    const ancestorIdsQuery = await db.execute(sql`
      WITH RECURSIVE ancestors AS (
        SELECT id, "parentId"
        FROM pages
        WHERE id IN ${permittedPageIds}
        UNION ALL
        SELECT p.id, p."parentId"
        FROM pages p
        JOIN ancestors a ON p.id = a."parentId"
      )
      SELECT id FROM ancestors;
    `);
    ancestorIds = (ancestorIdsQuery.rows as { id: string }[]).map(r => r.id);
  }

  const allVisiblePageIds = [...new Set([...permittedPageIds, ...ancestorIds])];

  return db.query.pages.findMany({
    where: and(
      inArray(pages.id, allVisiblePageIds),
      eq(pages.isTrashed, false)
    ),
    orderBy: [asc(pages.position)],
  });
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ driveId: string }> }
) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }

  const { driveId } = await context.params;

  // Check MCP token scope before drive access
  const scopeError = checkMCPDriveScope(auth, driveId);
  if (scopeError) return scopeError;

  const userId = auth.userId;

  try {
    // Find drive by id, but don't scope to owner yet
    const drive = await db.query.drives.findFirst({
      where: eq(drives.id, driveId),
    });

    if (!drive) {
      return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
    }

    let pageResults;

    // Check if user is owner
    const isOwner = drive.ownerId === userId;

    // Check if user is admin
    let isAdmin = false;
    if (!isOwner) {
      const adminMembership = await db.select()
        .from(driveMembers)
        .where(and(
          eq(driveMembers.driveId, drive.id),
          eq(driveMembers.userId, userId),
          eq(driveMembers.role, 'ADMIN')
        ))
        .limit(1);

      isAdmin = adminMembership.length > 0;
    }

    // If user owns the drive or is an admin, fetch all pages
    if (isOwner || isAdmin) {
      pageResults = await db.query.pages.findMany({
        where: and(
          eq(pages.driveId, drive.id),
          eq(pages.isTrashed, false)
        ),
        orderBy: [asc(pages.position)],
      });
    } else {
      // If user does not own the drive and is not an admin, fetch only permitted pages and their ancestors
      pageResults = await getPermittedPages(drive.id, userId);
    }

    // Get all task-linked page IDs to mark them in the tree
    const taskLinkedPageIds = await db.selectDistinct({ pageId: taskItems.pageId })
      .from(taskItems)
      .where(isNotNull(taskItems.pageId));
    const taskLinkedSet = new Set(taskLinkedPageIds.map(t => t.pageId));

    // Query activity logs to find pages with changes by OTHER users or AI since last view
    // This is more accurate than comparing updatedAt because:
    // 1. It excludes the current user's own edits (you don't need to be notified about your own changes)
    // 2. It properly tracks AI edits via isAiGenerated flag
    const pageIds = pageResults.map(p => p.id);
    const pagesWithActivityChanges = new Set<string>();

    if (pageIds.length > 0) {
      // Single efficient query using a CTE to find pages with unread changes
      // For viewed pages: check for activity after viewedAt by others/AI
      // For never-viewed pages: check for activity after cutoff date by others/AI
      // Build PostgreSQL array literal - Drizzle's sql template interpolates arrays as records,
      // so we need to construct the array explicitly with sql.join
      const pageIdsArrayLiteral = sql`ARRAY[${sql.join(pageIds.map(id => sql`${id}::text`), sql`, `)}]`;
      const unreadPagesResult = await db.execute(sql`
        WITH page_cutoffs AS (
          -- Get the cutoff timestamp for each page (viewedAt if viewed, cutoff date if not)
          SELECT
            p.id as page_id,
            COALESCE(upv."viewedAt", ${UNREAD_INDICATOR_CUTOFF_DATE}::timestamp) as cutoff_time
          FROM unnest(${pageIdsArrayLiteral}) as p(id)
          LEFT JOIN user_page_views upv ON upv."pageId" = p.id AND upv."userId" = ${userId}
        )
        SELECT DISTINCT pc.page_id
        FROM page_cutoffs pc
        JOIN activity_logs al ON al."pageId" = pc.page_id
        WHERE al."resourceType" = 'page'
          AND al.operation IN ('create', 'update')
          AND al.timestamp > pc.cutoff_time
          AND (
            al."userId" IS NULL                    -- system/unknown actor
            OR al."userId" != ${userId}            -- different user
            OR al."isAiGenerated" = true           -- AI edit (even if triggered by current user - should review)
          )
      `);

      for (const row of unreadPagesResult.rows as { page_id: string }[]) {
        pagesWithActivityChanges.add(row.page_id);
      }
    }

    // Add isTaskLinked and hasChanges flags to each page
    const pagesWithFlags = pageResults.map(page => {
      return {
        ...page,
        isTaskLinked: taskLinkedSet.has(page.id),
        hasChanges: pagesWithActivityChanges.has(page.id),
      };
    });

    const pageTree = buildTree(pagesWithFlags);
    return jsonResponse(pageTree);
  } catch (error) {
    loggers.api.error('Error fetching pages:', error as Error);
    return NextResponse.json(
      { error: 'Failed to fetch pages' },
      { status: 500 }
    );
  }
}
