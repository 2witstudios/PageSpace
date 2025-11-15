/**
 * Helper utilities for integrating audit trail into page operations
 *
 * Provides convenient wrappers and patterns for common page auditing scenarios.
 * Designed to minimize boilerplate while ensuring comprehensive tracking.
 */

import {
  createAuditEvent,
  createBulkAuditEvents,
  createPageVersion,
  computeChanges,
  trackAiOperation,
  type CreateAuditEventParams,
} from './index';
import { db, pages, eq } from '@pagespace/db';

/**
 * Context for determining if an action is AI-initiated
 */
export interface AuditContext {
  userId: string;
  requestId?: string;
  sessionId?: string;
  ipAddress?: string;
  userAgent?: string;

  // AI context (if applicable)
  isAiAction?: boolean;
  aiOperationId?: string;
  aiProvider?: string;
  aiModel?: string;
  aiPrompt?: string;
}

/**
 * Audits a page creation operation
 *
 * @param pageId - ID of the created page
 * @param context - Audit context
 * @returns The created audit event
 *
 * @example
 * ```typescript
 * await auditPageCreation(newPage.id, {
 *   userId: user.id,
 *   ipAddress: request.headers.get('x-forwarded-for'),
 *   userAgent: request.headers.get('user-agent')
 * });
 * ```
 */
export async function auditPageCreation(
  pageId: string,
  context: AuditContext
) {
  try {
    // Get the created page
    const page = await db.query.pages.findFirst({
      where: eq(pages.id, pageId),
    });

    if (!page) {
      console.warn(`[AuditPageCreation] Page not found: ${pageId}`);
      return null;
    }

    const auditEvent = await createAuditEvent({
      actionType: 'PAGE_CREATE',
      entityType: 'PAGE',
      entityId: pageId,
      userId: context.userId,
      isAiAction: context.isAiAction || false,
      aiOperationId: context.aiOperationId,
      driveId: page.driveId,
      afterState: {
        title: page.title,
        type: page.type,
        content: page.content,
        parentId: page.parentId,
      },
      description: `Created page "${page.title}"`,
      reason: context.aiPrompt || 'User created page',
      requestId: context.requestId,
      sessionId: context.sessionId,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });

    // Create initial version
    await createPageVersion({
      pageId,
      auditEventId: auditEvent.id,
      userId: context.userId,
      isAiGenerated: context.isAiAction || false,
      changeSummary: 'Initial version',
      changeType: context.isAiAction ? 'ai_edit' : 'user_edit',
    });

    return auditEvent;
  } catch (error) {
    // CRITICAL: Never fail user operations due to audit logging
    console.error('[AuditPageCreation] Failed to audit page creation:', error);
    return null;
  }
}

/**
 * Audits a page update operation with automatic versioning
 *
 * @param pageId - ID of the updated page
 * @param beforeState - State before the update
 * @param afterState - State after the update
 * @param context - Audit context
 * @returns The created audit event
 *
 * @example
 * ```typescript
 * const beforeState = { content: currentPage.content, title: currentPage.title };
 * // ... perform update ...
 * const afterState = { content: updatedPage.content, title: updatedPage.title };
 *
 * await auditPageUpdate(pageId, beforeState, afterState, {
 *   userId: user.id,
 *   ipAddress: request.headers.get('x-forwarded-for')
 * });
 * ```
 */
export async function auditPageUpdate(
  pageId: string,
  beforeState: Record<string, any>,
  afterState: Record<string, any>,
  context: AuditContext
) {
  try {
    // Get the page for metadata
    const page = await db.query.pages.findFirst({
      where: eq(pages.id, pageId),
    });

    if (!page) {
      console.warn(`[AuditPageUpdate] Page not found: ${pageId}`);
      return null;
    }

    // Compute changes
    const changes = computeChanges(beforeState, afterState);

    // Only proceed if there are actual changes
    if (Object.keys(changes).length === 0) {
      return null;
    }

    // Create audit event
    const auditEvent = await createAuditEvent({
      actionType: 'PAGE_UPDATE',
      entityType: 'PAGE',
      entityId: pageId,
      userId: context.userId,
      isAiAction: context.isAiAction || false,
      aiOperationId: context.aiOperationId,
      driveId: page.driveId,
      beforeState,
      afterState,
      changes,
      description: `Updated page "${page.title}"`,
      reason: context.aiPrompt || 'User edited page',
      requestId: context.requestId,
      sessionId: context.sessionId,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });

    // Create version snapshot if content changed
    if ('content' in changes) {
      await createPageVersion({
        pageId,
        auditEventId: auditEvent.id,
        userId: context.userId,
        isAiGenerated: context.isAiAction || false,
        changeSummary: context.aiPrompt
          ? `AI edit: ${context.aiPrompt.substring(0, 100)}...`
          : 'User edited content',
        changeType: context.isAiAction ? 'ai_edit' : 'user_edit',
      });
    }

    return auditEvent;
  } catch (error) {
    // CRITICAL: Never fail user operations due to audit logging
    console.error('[AuditPageUpdate] Failed to audit page update:', error);
    return null;
  }
}

/**
 * Audits a page deletion (soft delete) operation
 *
 * @param pageId - ID of the deleted page
 * @param context - Audit context
 * @param recursiveDelete - Whether children were also deleted
 * @returns The created audit event
 */
export async function auditPageDeletion(
  pageId: string,
  context: AuditContext,
  recursiveDelete = false
) {
  try {
    // Get the page before it's marked as trashed
    const page = await db.query.pages.findFirst({
      where: eq(pages.id, pageId),
    });

    if (!page) {
      console.warn(`[AuditPageDeletion] Page not found: ${pageId}`);
      return null;
    }

    const auditEvent = await createAuditEvent({
      actionType: 'PAGE_DELETE',
      entityType: 'PAGE',
      entityId: pageId,
      userId: context.userId,
      isAiAction: context.isAiAction || false,
      aiOperationId: context.aiOperationId,
      driveId: page.driveId,
      beforeState: {
        title: page.title,
        type: page.type,
        parentId: page.parentId,
        isTrashed: false,
      },
      afterState: {
        title: page.title,
        type: page.type,
        parentId: page.parentId,
        isTrashed: true,
      },
      changes: {
        isTrashed: { before: false, after: true },
      },
      description: `Deleted page "${page.title}"${recursiveDelete ? ' and children' : ''}`,
      reason: context.aiPrompt || 'User deleted page',
      metadata: {
        recursiveDelete,
      },
      requestId: context.requestId,
      sessionId: context.sessionId,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });

    return auditEvent;
  } catch (error) {
    // CRITICAL: Never fail user operations due to audit logging
    console.error('[AuditPageDeletion] Failed to audit page deletion:', error);
    return null;
  }
}

/**
 * Audits a page move operation
 *
 * @param pageId - ID of the moved page
 * @param oldParentId - Previous parent ID
 * @param newParentId - New parent ID
 * @param context - Audit context
 * @returns The created audit event
 */
export async function auditPageMove(
  pageId: string,
  oldParentId: string | null,
  newParentId: string | null,
  context: AuditContext
) {
  try {
    const page = await db.query.pages.findFirst({
      where: eq(pages.id, pageId),
    });

    if (!page) {
      console.warn(`[AuditPageMove] Page not found: ${pageId}`);
      return null;
    }

    const auditEvent = await createAuditEvent({
      actionType: 'PAGE_MOVE',
      entityType: 'PAGE',
      entityId: pageId,
      userId: context.userId,
      isAiAction: context.isAiAction || false,
      aiOperationId: context.aiOperationId,
      driveId: page.driveId,
      beforeState: { parentId: oldParentId },
      afterState: { parentId: newParentId },
      changes: {
        parentId: { before: oldParentId, after: newParentId },
      },
      description: `Moved page "${page.title}"`,
      reason: context.aiPrompt || 'User moved page',
      requestId: context.requestId,
      sessionId: context.sessionId,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });

    return auditEvent;
  } catch (error) {
    // CRITICAL: Never fail user operations due to audit logging
    console.error('[AuditPageMove] Failed to audit page move:', error);
    return null;
  }
}

/**
 * Audits a page rename operation
 *
 * @param pageId - ID of the renamed page
 * @param oldTitle - Previous title
 * @param newTitle - New title
 * @param context - Audit context
 * @returns The created audit event
 */
export async function auditPageRename(
  pageId: string,
  oldTitle: string,
  newTitle: string,
  context: AuditContext
) {
  try {
    const page = await db.query.pages.findFirst({
      where: eq(pages.id, pageId),
    });

    if (!page) {
      console.warn(`[AuditPageRename] Page not found: ${pageId}`);
      return null;
    }

    const auditEvent = await createAuditEvent({
      actionType: 'PAGE_RENAME',
      entityType: 'PAGE',
      entityId: pageId,
      userId: context.userId,
      isAiAction: context.isAiAction || false,
      aiOperationId: context.aiOperationId,
      driveId: page.driveId,
      beforeState: { title: oldTitle },
      afterState: { title: newTitle },
      changes: {
        title: { before: oldTitle, after: newTitle },
      },
      description: `Renamed page from "${oldTitle}" to "${newTitle}"`,
      reason: context.aiPrompt || 'User renamed page',
      requestId: context.requestId,
      sessionId: context.sessionId,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });

    return auditEvent;
  } catch (error) {
    // CRITICAL: Never fail user operations due to audit logging
    console.error('[AuditPageRename] Failed to audit page rename:', error);
    return null;
  }
}

/**
 * Audits bulk page operations with grouped tracking
 *
 * @param operations - Array of page operations
 * @param context - Audit context
 * @param operationType - Type of bulk operation
 * @returns Array of created audit events
 *
 * @example
 * ```typescript
 * await auditBulkPageOperation(
 *   pagesToUpdate.map(page => ({
 *     pageId: page.id,
 *     beforeState: { content: page.oldContent },
 *     afterState: { content: page.newContent }
 *   })),
 *   { userId: user.id, isAiAction: true, aiOperationId: op.id },
 *   'PAGE_UPDATE'
 * );
 * ```
 */
export async function auditBulkPageOperation(
  operations: Array<{
    pageId: string;
    beforeState?: Record<string, any>;
    afterState?: Record<string, any>;
  }>,
  context: AuditContext,
  operationType: 'PAGE_UPDATE' | 'PAGE_MOVE' | 'PAGE_DELETE'
) {
  try {
    // Generate operation ID to group all events
    const { createId } = await import('@paralleldrive/cuid2');
    const operationId = createId();

    // Fetch all pages for metadata
    const pageIds = operations.map((op) => op.pageId);
    const pagesData = await Promise.all(
      pageIds.map((id) =>
        db.query.pages.findFirst({ where: eq(pages.id, id) })
      )
    );

    // Create audit events for each operation
    const auditEventParams: CreateAuditEventParams[] = operations.map(
      (op, index) => {
        const page = pagesData[index];
        if (!page) {
          throw new Error(`Page not found: ${op.pageId}`);
        }

        const changes = op.beforeState && op.afterState
          ? computeChanges(op.beforeState, op.afterState)
          : undefined;

        return {
          actionType: operationType,
          entityType: 'PAGE' as const,
          entityId: op.pageId,
          userId: context.userId,
          isAiAction: context.isAiAction || false,
          aiOperationId: context.aiOperationId,
          driveId: page.driveId,
          beforeState: op.beforeState,
          afterState: op.afterState,
          changes,
          description: `Bulk ${operationType.toLowerCase()}: "${page.title}"`,
          reason: context.aiPrompt || `Bulk ${operationType.toLowerCase()} operation`,
          operationId, // Link all events together
          requestId: context.requestId,
          sessionId: context.sessionId,
          ipAddress: context.ipAddress,
          userAgent: context.userAgent,
        };
      }
    );

    const auditEvents = await createBulkAuditEvents(auditEventParams);

    // Create version snapshots for content updates
    if (operationType === 'PAGE_UPDATE') {
      const versionPromises = operations.map(async (op, index) => {
        const changes = op.beforeState && op.afterState
          ? computeChanges(op.beforeState, op.afterState)
          : {};

        // Only create version if content changed
        if ('content' in changes) {
          await createPageVersion({
            pageId: op.pageId,
            auditEventId: auditEvents[index].id,
            userId: context.userId,
            isAiGenerated: context.isAiAction || false,
            changeSummary: context.aiPrompt
              ? `Bulk AI edit: ${context.aiPrompt.substring(0, 100)}...`
              : 'Bulk user edit',
            changeType: context.isAiAction ? 'ai_edit' : 'user_edit',
          });
        }
      });

      await Promise.all(versionPromises);
    }

    return auditEvents;
  } catch (error) {
    // CRITICAL: Never fail user operations due to audit logging
    console.error('[AuditBulkPageOperation] Failed to audit bulk operation:', error);
    return [];
  }
}

/**
 * Extracts audit context from a Next.js request
 *
 * @param request - Next.js request object
 * @param userId - User ID from authentication
 * @returns Audit context object
 */
export function extractAuditContext(
  request: Request,
  userId: string
): AuditContext {
  return {
    userId,
    ipAddress: request.headers.get('x-forwarded-for') || undefined,
    userAgent: request.headers.get('user-agent') || undefined,
    requestId: request.headers.get('x-request-id') || undefined,
    sessionId: request.headers.get('x-session-id') || undefined,

    // AI context (if present in headers)
    isAiAction: request.headers.get('x-ai-action') === 'true',
    aiOperationId: request.headers.get('x-ai-operation-id') || undefined,
  };
}
