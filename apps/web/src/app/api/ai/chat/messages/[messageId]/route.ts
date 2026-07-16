import { NextResponse } from 'next/server';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { maskIdentifier } from '@/lib/logging/mask';
import {
  chatMessageRepository,
  processMessageContentUpdate,
} from '@/lib/repositories/chat-message-repository';
import { db } from '@pagespace/db/db'
import { eq } from '@pagespace/db/operators'
import { pages } from '@pagespace/db/schema/core';
import { getActorInfo, logMessageActivity } from '@pagespace/lib/monitoring/activity-logger';
import { broadcastAiMessageEdited, broadcastAiMessageDeleted } from '@/lib/websocket/socket-utils';
import { resolveTriggeredBy } from '@/lib/websocket/broadcast-triggered-by';
import { convertDbMessageToUIMessage } from '@/lib/ai/core/message-utils';
import { getState, invalidate } from '@/lib/ai/core/compaction/compaction-repository';
import { authenticateRequestWithOptions, checkMCPPageScope } from '@/lib/auth/request-auth';
import { isAuthError } from '@/lib/auth/auth-core';
import { canPrincipalEditPage } from '@/lib/auth/principal-permissions';

const AUTH_OPTIONS = { allow: ['session', 'mcp'] as const, requireCSRF: true };

/**
 * Helper to get driveId from a page for activity logging
 */
async function getPageDriveId(pageId: string, messageId: string): Promise<string | null> {
  const page = await db.query.pages.findFirst({
    where: eq(pages.id, pageId),
    columns: { driveId: true },
  });

  if (!page) {
    loggers.api.warn('Page not found for message - data integrity issue', {
      messageId: maskIdentifier(messageId),
      pageId: maskIdentifier(pageId)
    });
  }

  return page?.driveId ?? null;
}

/**
 * PATCH - Edit message content
 * Updates a chat message's content and sets editedAt timestamp
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ messageId: string }> }
) {
  try {
    // Authenticate
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) {
      auditRequest(request, { eventType: 'authz.access.denied', resourceType: 'message', resourceId: 'edit', details: { reason: 'auth_failed', method: 'PATCH' }, riskScore: 0.5 });
      return auth.error;
    }
    const userId = auth.userId;

    const { messageId } = await context.params;
    const { content } = await request.json();

    // Validate content
    if (!content || typeof content !== 'string') {
      return NextResponse.json(
        { error: 'Content is required and must be a string' },
        { status: 400 }
      );
    }

    // Get the message to check permissions
    const message = await chatMessageRepository.getMessageById(messageId);

    if (!message) {
      return NextResponse.json({ error: 'Message not found' }, { status: 404 });
    }

    // Check MCP page scope
    const scopeError = await checkMCPPageScope(auth, message.pageId);
    if (scopeError) return scopeError;

    // Check if user can edit the page this message belongs to
    const canEdit = await canPrincipalEditPage(auth, message.pageId);
    if (!canEdit) {
      loggers.api.warn('Edit message permission denied', {
        userId: maskIdentifier(userId),
        messageId: maskIdentifier(messageId),
        pageId: maskIdentifier(message.pageId)
      });
      auditRequest(request, { eventType: 'authz.access.denied', userId, resourceType: 'message', resourceId: messageId, details: { reason: 'no_edit_permission', method: 'PATCH', pageId: message.pageId }, riskScore: 0.5 });
      return NextResponse.json(
        { error: 'You do not have permission to edit messages in this chat' },
        { status: 403 }
      );
    }

    // A 'streaming' row is mid-flight: its content is a placeholder the generation is about
    // to overwrite via the execute-end/onFinish upsert. Editing it now would be silently
    // clobbered the moment that upsert lands. See Server Stream Durability epic PR 2.
    if (message.status === 'streaming') {
      return NextResponse.json(
        { error: 'This message is still generating and cannot be edited yet' },
        { status: 409 }
      );
    }

    // Get driveId for activity logging
    const driveId = await getPageDriveId(message.pageId, messageId);

    // Store original content for activity logging
    const originalContent = message.content;

    // Process content, preserving structured format if present
    const updatedContent = processMessageContentUpdate(message.content, content);

    // Update the message content and set editedAt
    await chatMessageRepository.updateMessageContent(messageId, updatedContent);

    // Invalidate compaction if the edited message was in the compacted range.
    // Awaited so the stale summary cannot be read by a concurrent request before we return.
    try {
      const state = await getState(message.conversationId, { source: 'page', pageId: message.pageId });
      // No row: a first compaction may be in flight — write the invalidation
      // tombstone so its pending insert loses. Row present: invalidate only
      // when the touched message is inside the compacted range.
      if (!state || (state.compactedUpToCreatedAt && message.createdAt <= state.compactedUpToCreatedAt)) {
        await invalidate(message.conversationId, { source: 'page', pageId: message.pageId });
      }
    } catch (err) {
      loggers.api.error('Failed to invalidate compaction state after message edit', err as Error);
    }

    // Broadcast to remote viewers. Failure must never break the request.
    void (async () => {
      try {
        const updated = await chatMessageRepository.getMessageById(messageId);
        if (!updated) return;
        const triggeredBy = await resolveTriggeredBy(userId, request);
        const uiMessage = await convertDbMessageToUIMessage(updated);
        await broadcastAiMessageEdited({
          messageId,
          pageId: message.pageId,
          conversationId: updated.conversationId,
          parts: uiMessage.parts,
          editedAt: (updated.editedAt ?? new Date()).toISOString(),
          triggeredBy,
        });
      } catch (broadcastError) {
        loggers.api.error('Failed to broadcast chat message edit', broadcastError as Error, {
          messageId: maskIdentifier(messageId),
          pageId: maskIdentifier(message.pageId),
        });
      }
    })();

    // Log activity for audit trail (non-blocking)
    try {
      const actorInfo = await getActorInfo(userId);
      logMessageActivity(userId, 'message_update', {
        id: messageId,
        pageId: message.pageId,
        driveId,
        conversationType: 'ai_chat',
      }, actorInfo, {
        previousContent: originalContent,
        newContent: updatedContent,
      });
    } catch (loggingError) {
      loggers.api.error('Failed to log message update activity', loggingError as Error, {
        messageId: maskIdentifier(messageId),
        pageId: maskIdentifier(message.pageId)
      });
    }

    loggers.api.info('Message edited successfully', {
      userId: maskIdentifier(userId),
      messageId: maskIdentifier(messageId),
      pageId: maskIdentifier(message.pageId)
    });

    auditRequest(request, { eventType: 'data.write', userId, resourceType: 'message', resourceId: messageId, details: {
      source: 'ai-chat',
      pageId: message.pageId,
    } });

    return NextResponse.json({
      success: true,
      message: 'Message updated successfully'
    });
  } catch (error) {
    loggers.api.error('Error editing message', error as Error);
    return NextResponse.json(
      { error: 'Failed to edit message' },
      { status: 500 }
    );
  }
}

/**
 * DELETE - Soft delete a message
 * Sets isActive to false to hide the message
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ messageId: string }> }
) {
  try {
    // Authenticate
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) {
      auditRequest(request, { eventType: 'authz.access.denied', resourceType: 'message', resourceId: 'delete', details: { reason: 'auth_failed', method: 'DELETE' }, riskScore: 0.5 });
      return auth.error;
    }
    const userId = auth.userId;

    const { messageId } = await context.params;

    // Get the message to check permissions
    const message = await chatMessageRepository.getMessageById(messageId);

    if (!message) {
      return NextResponse.json({ error: 'Message not found' }, { status: 404 });
    }

    // Check MCP page scope
    const scopeError = await checkMCPPageScope(auth, message.pageId);
    if (scopeError) return scopeError;

    // Check if user can edit the page this message belongs to
    const canEdit = await canPrincipalEditPage(auth, message.pageId);
    if (!canEdit) {
      loggers.api.warn('Delete message permission denied', {
        userId: maskIdentifier(userId),
        messageId: maskIdentifier(messageId),
        pageId: maskIdentifier(message.pageId)
      });
      auditRequest(request, { eventType: 'authz.access.denied', userId, resourceType: 'message', resourceId: messageId, details: { reason: 'no_edit_permission', method: 'DELETE', pageId: message.pageId }, riskScore: 0.5 });
      return NextResponse.json(
        { error: 'You do not have permission to delete messages in this chat' },
        { status: 403 }
      );
    }

    // A 'streaming' row is mid-flight: deleting it now would race the execute-end/onFinish
    // upsert, which does not check isActive and would resurrect the row's content into an
    // inactive-but-visible-again state. See Server Stream Durability epic PR 2.
    if (message.status === 'streaming') {
      return NextResponse.json(
        { error: 'This message is still generating and cannot be deleted yet' },
        { status: 409 }
      );
    }

    // Get driveId for activity logging
    const driveId = await getPageDriveId(message.pageId, messageId);

    // Store content for audit trail before deletion
    const deletedContent = message.content;

    // Soft delete the message
    await chatMessageRepository.softDeleteMessage(messageId);

    // Invalidate compaction if the deleted message was in the compacted range.
    // Awaited so the stale summary cannot be read by a concurrent request before we return.
    try {
      const state = await getState(message.conversationId, { source: 'page', pageId: message.pageId });
      // No row: a first compaction may be in flight — write the invalidation
      // tombstone so its pending insert loses. Row present: invalidate only
      // when the touched message is inside the compacted range.
      if (!state || (state.compactedUpToCreatedAt && message.createdAt <= state.compactedUpToCreatedAt)) {
        await invalidate(message.conversationId, { source: 'page', pageId: message.pageId });
      }
    } catch (err) {
      loggers.api.error('Failed to invalidate compaction state after message delete', err as Error);
    }

    // Broadcast to remote viewers. Failure must never break the request.
    void (async () => {
      try {
        const triggeredBy = await resolveTriggeredBy(userId, request);
        await broadcastAiMessageDeleted({
          messageId,
          pageId: message.pageId,
          conversationId: message.conversationId,
          triggeredBy,
        });
      } catch (broadcastError) {
        loggers.api.error('Failed to broadcast chat message delete', broadcastError as Error, {
          messageId: maskIdentifier(messageId),
          pageId: maskIdentifier(message.pageId),
        });
      }
    })();

    // Log activity for audit trail (non-blocking)
    try {
      const actorInfo = await getActorInfo(userId);
      logMessageActivity(userId, 'message_delete', {
        id: messageId,
        pageId: message.pageId,
        driveId,
        conversationType: 'ai_chat',
      }, actorInfo, {
        previousContent: deletedContent,
      });
    } catch (loggingError) {
      loggers.api.error('Failed to log message deletion activity', loggingError as Error, {
        messageId: maskIdentifier(messageId),
        pageId: maskIdentifier(message.pageId)
      });
    }

    loggers.api.info('Message deleted successfully', {
      userId: maskIdentifier(userId),
      messageId: maskIdentifier(messageId),
      pageId: maskIdentifier(message.pageId)
    });

    auditRequest(request, { eventType: 'data.delete', userId, resourceType: 'message', resourceId: messageId, details: {
      source: 'ai-chat',
      pageId: message.pageId,
    } });

    return NextResponse.json({
      success: true,
      message: 'Message deleted successfully'
    });
  } catch (error) {
    loggers.api.error('Error deleting message', error as Error);
    return NextResponse.json(
      { error: 'Failed to delete message' },
      { status: 500 }
    );
  }
}
