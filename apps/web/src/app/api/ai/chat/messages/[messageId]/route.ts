import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError, checkMCPPageScope, canPrincipalEditPage } from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { maskIdentifier } from '@/lib/logging/mask';
import { db } from '@pagespace/db/db'
import { eq } from '@pagespace/db/operators'
import { pages } from '@pagespace/db/schema/core';
import { getActorInfo, logMessageActivity } from '@pagespace/lib/monitoring/activity-logger';
import { resolveTriggeredBy } from '@/lib/websocket/broadcast-triggered-by';
import {
  messageRepository,
  processMessageContentUpdate,
} from '@/lib/repositories/message-repository';
import { getState, invalidate } from '@/lib/ai/core/compaction/compaction-repository';

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
      auditRequest(request, { eventType: 'authz.access.denied', resourceType: 'message', resourceId: 'edit', details: { reason: 'auth_failed', method: 'PATCH', authFailureReason: auth.authFailureReason }, riskScore: 0.5 });
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

    // Get the message to check permissions. Reads the UNIFIED `messages` table
    // since the message-table merge (epic "Agent-Session Single Source of
    // Truth", Phase 4 / D6); `pageId` is derived from the conversation.
    //
    // A NULL `pageId` means the id names a GLOBAL-assistant message, which had
    // no `chat_messages` row before the cutover and so simply did not resolve
    // here. It must keep not resolving: this route's permission model is page
    // permissions, and the global assistant has its own route
    // (/api/ai/global/[id]/messages/[messageId]) with its own ownership check.
    const message = await messageRepository.getMessageById(messageId);

    if (!message || message.pageId === null) {
      return NextResponse.json({ error: 'Message not found' }, { status: 404 });
    }
    const messagePageId = message.pageId;

    // Check MCP page scope
    const scopeError = await checkMCPPageScope(auth, messagePageId);
    if (scopeError) return scopeError;

    // Check if user can edit the page this message belongs to
    const canEdit = await canPrincipalEditPage(auth, messagePageId);
    if (!canEdit) {
      loggers.api.warn('Edit message permission denied', {
        userId: maskIdentifier(userId),
        messageId: maskIdentifier(messageId),
        pageId: maskIdentifier(messagePageId)
      });
      auditRequest(request, { eventType: 'authz.access.denied', userId, resourceType: 'message', resourceId: messageId, details: { reason: 'no_edit_permission', method: 'PATCH', pageId: messagePageId }, riskScore: 0.5 });
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
    const driveId = await getPageDriveId(messagePageId, messageId);

    // Store original content for activity logging
    const originalContent = message.content;

    // Process content, preserving structured format if present
    const updatedContent = processMessageContentUpdate(message.content, content);

    // Update the message content via the repository choke point: one
    // transaction with the rev bump, then the legacy chat:message_edited
    // broadcast + authoritative conversation:message_updated event — both
    // emitted from the repository, not this route (Agent-Session SSoT §3).
    await messageRepository.editPageMessage({
      messageId,
      pageId: messagePageId,
      conversationId: message.conversationId,
      updatedContent,
      legacyTriggeredBy: await resolveTriggeredBy(userId, request),
    });

    // Invalidate compaction if the edited message was in the compacted range.
    // Awaited so the stale summary cannot be read by a concurrent request before we return.
    try {
      const state = await getState(message.conversationId, { source: 'page', pageId: messagePageId });
      // No row: a first compaction may be in flight — write the invalidation
      // tombstone so its pending insert loses. Row present: invalidate only
      // when the touched message is inside the compacted range.
      if (!state || (state.compactedUpToCreatedAt && message.createdAt <= state.compactedUpToCreatedAt)) {
        await invalidate(message.conversationId, { source: 'page', pageId: messagePageId });
      }
    } catch (err) {
      loggers.api.error('Failed to invalidate compaction state after message edit', err as Error);
    }

    // Log activity for audit trail (non-blocking)
    try {
      const actorInfo = await getActorInfo(userId);
      logMessageActivity(userId, 'message_update', {
        id: messageId,
        pageId: messagePageId,
        driveId,
        conversationType: 'ai_chat',
      }, actorInfo, {
        previousContent: originalContent,
        newContent: updatedContent,
      });
    } catch (loggingError) {
      loggers.api.error('Failed to log message update activity', loggingError as Error, {
        messageId: maskIdentifier(messageId),
        pageId: maskIdentifier(messagePageId)
      });
    }

    loggers.api.info('Message edited successfully', {
      userId: maskIdentifier(userId),
      messageId: maskIdentifier(messageId),
      pageId: maskIdentifier(messagePageId)
    });

    auditRequest(request, { eventType: 'data.write', userId, resourceType: 'message', resourceId: messageId, details: {
      source: 'ai-chat',
      pageId: messagePageId,
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
      auditRequest(request, { eventType: 'authz.access.denied', resourceType: 'message', resourceId: 'delete', details: { reason: 'auth_failed', method: 'DELETE', authFailureReason: auth.authFailureReason }, riskScore: 0.5 });
      return auth.error;
    }
    const userId = auth.userId;

    const { messageId } = await context.params;

    // Get the message to check permissions. Reads the UNIFIED `messages` table
    // since the message-table merge (epic "Agent-Session Single Source of
    // Truth", Phase 4 / D6); `pageId` is derived from the conversation.
    //
    // A NULL `pageId` means the id names a GLOBAL-assistant message, which had
    // no `chat_messages` row before the cutover and so simply did not resolve
    // here. It must keep not resolving: this route's permission model is page
    // permissions, and the global assistant has its own route
    // (/api/ai/global/[id]/messages/[messageId]) with its own ownership check.
    const message = await messageRepository.getMessageById(messageId);

    if (!message || message.pageId === null) {
      return NextResponse.json({ error: 'Message not found' }, { status: 404 });
    }
    const messagePageId = message.pageId;

    // Check MCP page scope
    const scopeError = await checkMCPPageScope(auth, messagePageId);
    if (scopeError) return scopeError;

    // Check if user can edit the page this message belongs to
    const canEdit = await canPrincipalEditPage(auth, messagePageId);
    if (!canEdit) {
      loggers.api.warn('Delete message permission denied', {
        userId: maskIdentifier(userId),
        messageId: maskIdentifier(messageId),
        pageId: maskIdentifier(messagePageId)
      });
      auditRequest(request, { eventType: 'authz.access.denied', userId, resourceType: 'message', resourceId: messageId, details: { reason: 'no_edit_permission', method: 'DELETE', pageId: messagePageId }, riskScore: 0.5 });
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
    const driveId = await getPageDriveId(messagePageId, messageId);

    // Store content for audit trail before deletion
    const deletedContent = message.content;

    // Soft delete via the repository choke point (rev bump + legacy
    // chat:message_deleted + authoritative conversation:message_deleted).
    await messageRepository.softDeletePageMessage({
      messageId,
      pageId: messagePageId,
      conversationId: message.conversationId,
      legacyTriggeredBy: await resolveTriggeredBy(userId, request),
    });

    // Invalidate compaction if the deleted message was in the compacted range.
    // Awaited so the stale summary cannot be read by a concurrent request before we return.
    try {
      const state = await getState(message.conversationId, { source: 'page', pageId: messagePageId });
      // No row: a first compaction may be in flight — write the invalidation
      // tombstone so its pending insert loses. Row present: invalidate only
      // when the touched message is inside the compacted range.
      if (!state || (state.compactedUpToCreatedAt && message.createdAt <= state.compactedUpToCreatedAt)) {
        await invalidate(message.conversationId, { source: 'page', pageId: messagePageId });
      }
    } catch (err) {
      loggers.api.error('Failed to invalidate compaction state after message delete', err as Error);
    }

    // Log activity for audit trail (non-blocking)
    try {
      const actorInfo = await getActorInfo(userId);
      logMessageActivity(userId, 'message_delete', {
        id: messageId,
        pageId: messagePageId,
        driveId,
        conversationType: 'ai_chat',
      }, actorInfo, {
        previousContent: deletedContent,
      });
    } catch (loggingError) {
      loggers.api.error('Failed to log message deletion activity', loggingError as Error, {
        messageId: maskIdentifier(messageId),
        pageId: maskIdentifier(messagePageId)
      });
    }

    loggers.api.info('Message deleted successfully', {
      userId: maskIdentifier(userId),
      messageId: maskIdentifier(messageId),
      pageId: maskIdentifier(messagePageId)
    });

    auditRequest(request, { eventType: 'data.delete', userId, resourceType: 'message', resourceId: messageId, details: {
      source: 'ai-chat',
      pageId: messagePageId,
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
