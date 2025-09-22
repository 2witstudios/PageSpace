import { NextResponse } from 'next/server';
import { authenticateMCPRequest, isAuthError } from '@/lib/auth';
import { db, pages, eq } from '@pagespace/db';
import { canUserEditPage } from '@pagespace/lib/server';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/socket-utils';
import { loggers } from '@pagespace/lib/logger-config';

/**
 * POST /api/pages/bulk/update-content
 * Update content in multiple pages in one atomic operation
 */
export async function POST(request: Request) {
  try {
    const auth = await authenticateMCPRequest(request);
    if (isAuthError(auth)) return auth.error;
    const { userId } = auth;

    const body = await request.json();
    const { updates } = body;

    if (!updates || !Array.isArray(updates) || updates.length === 0) {
      return NextResponse.json(
        { error: 'updates array is required and must not be empty' },
        { status: 400 }
      );
    }

    // Validate update objects
    for (const update of updates) {
      if (!update.pageId || !update.content === undefined) {
        return NextResponse.json(
          { error: 'Each update must have pageId and content fields' },
          { status: 400 }
        );
      }
      if (update.operation && !['replace', 'append', 'prepend'].includes(update.operation)) {
        return NextResponse.json(
          { error: 'Operation must be one of: replace, append, prepend' },
          { status: 400 }
        );
      }
    }

    const updatedPages: Array<{ id: string; title: string; operation: string; driveId: string }> = [];

    await db.transaction(async (tx) => {
      for (const update of updates) {
        // Check permissions
        const canEdit = await canUserEditPage(userId, update.pageId);
        if (!canEdit) {
          throw new Error(`No permission to update page ${update.pageId}`);
        }

        // Get current page
        const [currentPage] = await tx
          .select({ content: pages.content, title: pages.title, driveId: pages.driveId })
          .from(pages)
          .where(eq(pages.id, update.pageId));

        if (!currentPage) {
          throw new Error(`Page ${update.pageId} not found`);
        }

        const operation = update.operation || 'replace';
        let newContent: string;
        switch (operation) {
          case 'replace':
            newContent = update.content;
            break;
          case 'append':
            newContent = currentPage.content + update.content;
            break;
          case 'prepend':
            newContent = update.content + currentPage.content;
            break;
          default:
            newContent = update.content;
        }

        // Update the page
        await tx
          .update(pages)
          .set({
            content: newContent,
            updatedAt: new Date(),
          })
          .where(eq(pages.id, update.pageId));

        updatedPages.push({
          id: update.pageId,
          title: currentPage.title,
          operation,
          driveId: currentPage.driveId,
        });
      }
    });

    // Broadcast update events
    for (const page of updatedPages) {
      await broadcastPageEvent(
        createPageEventPayload(page.driveId, page.id, 'updated', {
          title: page.title,
        })
      );
    }

    loggers.api.info('Bulk update content completed', {
      updateCount: updates.length,
      updatedCount: updatedPages.length,
      userId
    });

    return NextResponse.json({
      success: true,
      updatedPages: updatedPages.map(p => ({
        id: p.id,
        title: p.title,
        operation: p.operation,
      })),
      summary: `Successfully updated ${updatedPages.length} page${updatedPages.length === 1 ? '' : 's'}`,
      stats: {
        totalUpdated: updatedPages.length,
        operations: {
          replace: updatedPages.filter(p => p.operation === 'replace').length,
          append: updatedPages.filter(p => p.operation === 'append').length,
          prepend: updatedPages.filter(p => p.operation === 'prepend').length,
        },
      },
      nextSteps: [
        'Use read_page to verify the content changes',
        'Use list_pages to see the updated pages',
      ]
    });

  } catch (error) {
    loggers.api.error('Error in bulk update content:', error as Error);
    return NextResponse.json(
      { error: `Bulk content update failed: ${error instanceof Error ? error.message : String(error)}` },
      { status: 500 }
    );
  }
}