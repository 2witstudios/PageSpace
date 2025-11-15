import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { db, aiOperations, auditEvents, pages, eq, and } from '@pagespace/db';
import { canUserEditPage } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/server';
import { createAuditEvent } from '@pagespace/lib/server';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/socket-utils';

const AUTH_OPTIONS = { allow: ['jwt', 'mcp'] as const, requireCSRF: true };

/**
 * POST /api/ai/operations/[operationId]/undo
 * Undo an AI operation by reverting changes
 *
 * This endpoint finds the AI operation and its associated audit events,
 * then reverts the changes by restoring the beforeState.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ operationId: string }> }
) {
  const { operationId } = await context.params;
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }
  const userId = auth.userId;

  try {
    // Find the AI operation
    const operation = await db.query.aiOperations.findFirst({
      where: eq(aiOperations.id, operationId),
    });

    if (!operation) {
      return NextResponse.json(
        { error: 'AI operation not found' },
        { status: 404 }
      );
    }

    // Verify the user owns this operation
    if (operation.userId !== userId) {
      return NextResponse.json(
        { error: 'Permission denied', details: 'You can only undo your own AI operations' },
        { status: 403 }
      );
    }

    // Verify operation was successful (can't undo failed operations)
    if (operation.status !== 'COMPLETED') {
      return NextResponse.json(
        { error: 'Cannot undo operation', details: `Operation status is ${operation.status}` },
        { status: 400 }
      );
    }

    // Find all audit events associated with this AI operation
    const events = await db.query.auditEvents.findMany({
      where: eq(auditEvents.aiOperationId, operationId),
    });

    if (events.length === 0) {
      return NextResponse.json(
        { error: 'No audit trail found for this operation' },
        { status: 404 }
      );
    }

    const revertedEntities: Array<{ entityType: string; entityId: string; title?: string }> = [];

    // Revert each event by restoring beforeState
    await db.transaction(async (tx) => {
      for (const event of events) {
        if (event.entityType === 'PAGE' && event.beforeState) {
          const pageId = event.entityId;

          // Check edit permission
          const canEdit = await canUserEditPage(userId, pageId);
          if (!canEdit) {
            throw new Error(`No permission to revert changes to page ${pageId}`);
          }

          // Get current page
          const currentPage = await tx.query.pages.findFirst({
            where: eq(pages.id, pageId),
          });

          if (!currentPage) {
            loggers.api.warn(`Page ${pageId} not found during undo`);
            continue;
          }

          // Restore beforeState fields
          const updateData: Record<string, any> = {};
          const beforeState = event.beforeState as Record<string, any>;

          if ('content' in beforeState) {
            updateData.content = beforeState.content;
          }
          if ('title' in beforeState) {
            updateData.title = beforeState.title;
          }
          if ('parentId' in beforeState) {
            updateData.parentId = beforeState.parentId;
          }

          // Only update if there are changes
          if (Object.keys(updateData).length > 0) {
            updateData.updatedAt = new Date();

            await tx.update(pages)
              .set(updateData)
              .where(eq(pages.id, pageId));

            revertedEntities.push({
              entityType: 'PAGE',
              entityId: pageId,
              title: currentPage.title,
            });

            // Broadcast update event
            if (currentPage.driveId) {
              await broadcastPageEvent(
                createPageEventPayload(currentPage.driveId, pageId, 'updated', {
                  title: updateData.title || currentPage.title,
                  parentId: updateData.parentId !== undefined ? updateData.parentId : currentPage.parentId,
                })
              );
            }
          }
        }
        // Add support for other entity types here (e.g., PERMISSION, FILE, etc.)
      }
    });

    // Create audit event for the undo operation
    if (revertedEntities.length > 0) {
      await createAuditEvent({
        actionType: 'PAGE_UPDATE',
        entityType: 'PAGE',
        entityId: revertedEntities[0].entityId,
        userId,
        driveId: operation.driveId,
        isAiAction: false,
        description: `Undid AI operation: ${operation.operationType}`,
        reason: `User reverted AI changes from operation ${operationId}`,
        metadata: {
          originalOperationId: operationId,
          revertedCount: revertedEntities.length,
          originalPrompt: operation.prompt,
        },
      }).catch(error => {
        loggers.api.error('Failed to create undo audit event:', error as Error);
      });
    }

    loggers.api.info('AI operation undone', {
      operationId,
      userId,
      revertedCount: revertedEntities.length,
    });

    return NextResponse.json({
      success: true,
      message: `Successfully undid AI operation`,
      operationId,
      revertedCount: revertedEntities.length,
      revertedEntities: revertedEntities.map(e => ({
        type: e.entityType,
        id: e.entityId,
        title: e.title,
      })),
    });
  } catch (error) {
    loggers.api.error('Error undoing AI operation:', error as Error);

    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes('permission')) {
      return NextResponse.json(
        { error: errorMessage },
        { status: 403 }
      );
    }

    return NextResponse.json(
      { error: 'Failed to undo AI operation' },
      { status: 500 }
    );
  }
}
