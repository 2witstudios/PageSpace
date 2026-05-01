import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError, checkMCPPageScope } from '@/lib/auth';
import { canUserEditPage } from '@pagespace/lib/permissions/permissions';
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
    const canEdit = await canUserEditPage(userId, message.pageId);
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

    // Get driveId for activity logging
    const driveId = await getPageDriveId(message.pageId, messageId);

    // Store original content for activity logging
    const originalContent = message.content;

    // Process content, preserving structured format if present
    const updatedContent = processMessageContentUpdate(message.content, content);

    // Update the message content and set editedAt
    await chatMessageRepository.updateMessageContent(messageId, updatedContent);

    // Broadcast to remote viewers. Failure must never break the request.
    void (async () => {
      try {
        const updated = await chatMessageRepository.getMessageById(messageId);
        if (!updated) return;
        const triggeredBy = await resolveTriggeredBy(userId, request);
        const uiMessage = convertDbMessageToUIMessage(updated);
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
    const canEdit = await canUserEditPage(userId, message.pageId);
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

    // Get driveId for activity logging
    const driveId = await getPageDriveId(message.pageId, messageId);

    // Store content for audit trail before deletion
    const deletedContent = message.content;

    // Soft delete the message
    await chatMessageRepository.softDeleteMessage(messageId);

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
