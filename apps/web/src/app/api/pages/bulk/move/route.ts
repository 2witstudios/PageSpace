import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

const AUTH_OPTIONS = { allow: ['jwt', 'mcp'] as const };
import { db, pages, eq, and, sql } from '@pagespace/db';
import { canUserEditPage, getUserDriveAccess } from '@pagespace/lib/server';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/socket-utils';
import { loggers } from '@pagespace/lib/logger-config';

/**
 * POST /api/pages/bulk/move
 * Move multiple pages to a new parent location in one operation
 */
export async function POST(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const { userId } = auth;

    const body = await request.json();
    const { pageIds, targetParentId, targetDriveId, maintainOrder = true } = body;

    if (!pageIds || !Array.isArray(pageIds) || pageIds.length === 0) {
      return NextResponse.json(
        { error: 'pageIds array is required and must not be empty' },
        { status: 400 }
      );
    }

    if (!targetDriveId) {
      return NextResponse.json(
        { error: 'targetDriveId is required' },
        { status: 400 }
      );
    }

    // Verify drive access
    const hasDriveAccess = await getUserDriveAccess(userId, targetDriveId);
    if (!hasDriveAccess) {
      return NextResponse.json(
        { error: 'You don\'t have access to the target drive' },
        { status: 403 }
      );
    }

    // Check permissions for all source pages
    const sourcePages: Array<{ id: string; title: string; parentId: string | null; position: number }> = [];
    for (const pageId of pageIds) {
      const canEdit = await canUserEditPage(userId, pageId);
      if (!canEdit) {
        return NextResponse.json(
          { error: `No permission to move page ${pageId}` },
          { status: 403 }
        );
      }

      const [page] = await db
        .select()
        .from(pages)
        .where(eq(pages.id, pageId));

      if (page) {
        sourcePages.push(page);
      } else {
        return NextResponse.json(
          { error: `Page ${pageId} not found` },
          { status: 404 }
        );
      }
    }

    // Check permission for target parent
    if (targetParentId) {
      const canEditTarget = await canUserEditPage(userId, targetParentId);
      if (!canEditTarget) {
        return NextResponse.json(
          { error: 'No permission to move pages to target location' },
          { status: 403 }
        );
      }
    }

    // Get next available position in target
    const [maxPosition] = await db
      .select({ maxPos: sql`MAX(${pages.position})` })
      .from(pages)
      .where(and(
        eq(pages.driveId, targetDriveId),
        targetParentId ? eq(pages.parentId, targetParentId) : sql`${pages.parentId} IS NULL`
      ));

    let nextPosition = ((maxPosition as { maxPos: number | null })?.maxPos || 0) + 1;

    // Sort pages by current position if maintaining order
    if (maintainOrder) {
      sourcePages.sort((a, b) => a.position - b.position);
    }

    // Move all pages
    const movedPages: Array<{ id: string; title: string; parentId: string | null; position: number; type: string }> = [];
    await db.transaction(async (tx) => {
      for (const page of sourcePages) {
        const [moved] = await tx
          .update(pages)
          .set({
            parentId: targetParentId,
            driveId: targetDriveId,
            position: nextPosition++,
            updatedAt: new Date(),
          })
          .where(eq(pages.id, page.id))
          .returning();

        movedPages.push(moved);
      }
    });

    // Broadcast events
    for (const page of movedPages) {
      await broadcastPageEvent(
        createPageEventPayload(targetDriveId, page.id, 'moved', {
          parentId: targetParentId,
          title: page.title,
        })
      );
    }

    loggers.api.info('Bulk move pages completed', {
      pageIds,
      targetDriveId,
      targetParentId,
      movedCount: movedPages.length,
      userId
    });

    return NextResponse.json({
      success: true,
      movedCount: movedPages.length,
      targetLocation: {
        driveId: targetDriveId,
        parentId: targetParentId || 'root',
      },
      movedPages: movedPages.map(p => ({
        id: p.id,
        title: p.title,
        type: p.type,
        newPosition: p.position,
      })),
      summary: `Successfully moved ${movedPages.length} page${movedPages.length === 1 ? '' : 's'}`,
      stats: {
        totalMoved: movedPages.length,
        types: [...new Set(movedPages.map(p => p.type))],
      },
      nextSteps: [
        'Use list_pages to verify the new structure',
        'Consider organizing with folders if needed',
        'Update any references to moved pages',
      ]
    });

  } catch (error) {
    loggers.api.error('Error in bulk move pages:', error as Error);
    return NextResponse.json(
      { error: `Bulk move failed: ${error instanceof Error ? error.message : String(error)}` },
      { status: 500 }
    );
  }
}
