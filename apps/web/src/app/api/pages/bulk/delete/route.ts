import { NextResponse } from 'next/server';
import { authenticateMCPRequest, isAuthError } from '@/lib/auth';
import { db, pages, eq, and, inArray } from '@pagespace/db';
import { canUserDeletePage, canUserEditPage } from '@pagespace/lib/server';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/socket-utils';
import { loggers } from '@pagespace/lib/logger-config';

/**
 * POST /api/pages/bulk/delete
 * Delete multiple pages in one atomic operation
 */
export async function POST(request: Request) {
  try {
    const auth = await authenticateMCPRequest(request);
    if (isAuthError(auth)) return auth.error;
    const { userId } = auth;

    const body = await request.json();
    const { pageIds, includeChildren = false } = body;

    if (!pageIds || !Array.isArray(pageIds) || pageIds.length === 0) {
      return NextResponse.json(
        { error: 'pageIds array is required and must not be empty' },
        { status: 400 }
      );
    }

    const deletedPages: Array<{ id: string; title: string; driveId: string; deletedCount: number }> = [];
    const allDeletedIds: string[] = [];

    await db.transaction(async (tx) => {
      for (const pageId of pageIds) {
        // Check permissions
        const canDelete = includeChildren
          ? await canUserDeletePage(userId, pageId)
          : await canUserEditPage(userId, pageId);

        if (!canDelete) {
          throw new Error(`No permission to delete page ${pageId}`);
        }

        // Get page info
        const [page] = await tx
          .select({ id: pages.id, title: pages.title, driveId: pages.driveId })
          .from(pages)
          .where(eq(pages.id, pageId));

        if (!page) {
          throw new Error(`Page ${pageId} not found`);
        }

        if (includeChildren) {
          // Recursively find all children
          const getAllChildren = async (parentId: string): Promise<string[]> => {
            const children = await tx
              .select({ id: pages.id })
              .from(pages)
              .where(and(
                eq(pages.parentId, parentId),
                eq(pages.driveId, page.driveId)
              ));

            const allIds = [];
            for (const child of children) {
              allIds.push(child.id);
              const grandChildren = await getAllChildren(child.id);
              allIds.push(...grandChildren);
            }
            return allIds;
          };

          const childIds = await getAllChildren(pageId);
          const deleteIds = [pageId, ...childIds];

          // Delete all pages
          await tx
            .update(pages)
            .set({
              isTrashed: true,
              trashedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(inArray(pages.id, deleteIds));

          allDeletedIds.push(...deleteIds);
          deletedPages.push({
            id: page.id,
            title: page.title,
            driveId: page.driveId,
            deletedCount: deleteIds.length,
          });
        } else {
          // Delete single page
          await tx
            .update(pages)
            .set({
              isTrashed: true,
              trashedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(pages.id, pageId));

          allDeletedIds.push(pageId);
          deletedPages.push({
            id: page.id,
            title: page.title,
            driveId: page.driveId,
            deletedCount: 1,
          });
        }
      }
    });

    // Broadcast deletion events
    for (const deletedId of allDeletedIds) {
      const page = deletedPages.find(p => p.id === deletedId);
      if (page) {
        await broadcastPageEvent(
          createPageEventPayload(page.driveId, deletedId, 'trashed', {})
        );
      }
    }

    loggers.api.info('Bulk delete pages completed', {
      pageIds,
      includeChildren,
      totalDeleted: allDeletedIds.length,
      userId
    });

    return NextResponse.json({
      success: true,
      deletedPages: deletedPages.map(p => ({
        id: p.id,
        title: p.title,
        deletedCount: p.deletedCount,
      })),
      totalDeleted: allDeletedIds.length,
      summary: `Successfully deleted ${deletedPages.length} page${deletedPages.length === 1 ? '' : 's'} (${allDeletedIds.length} total including children)`,
      stats: {
        pagesRequested: pageIds.length,
        pagesDeleted: deletedPages.length,
        totalDeleted: allDeletedIds.length,
      },
      nextSteps: [
        'Use list_pages to verify the pages are gone',
        'Check trash if you need to restore any pages',
      ]
    });

  } catch (error) {
    loggers.api.error('Error in bulk delete pages:', error as Error);
    return NextResponse.json(
      { error: `Bulk delete failed: ${error instanceof Error ? error.message : String(error)}` },
      { status: 500 }
    );
  }
}