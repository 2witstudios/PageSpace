import { NextRequest, NextResponse } from 'next/server';
import { buildTree } from '@pagespace/lib/server';
import { pages, drives, pagePermissions, driveMembers, db, and, eq, inArray, asc, sql } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

const AUTH_OPTIONS = { allow: ['jwt', 'mcp'] as const, requireCSRF: true };

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
  const userId = auth.userId;

  try {
    const { driveId } = await context.params;

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

    const pageTree = buildTree(pageResults);
    return NextResponse.json(pageTree);
  } catch (error) {
    loggers.api.error('Error fetching pages:', error as Error);
    return NextResponse.json(
      { error: 'Failed to fetch pages' },
      { status: 500 }
    );
  }
}
