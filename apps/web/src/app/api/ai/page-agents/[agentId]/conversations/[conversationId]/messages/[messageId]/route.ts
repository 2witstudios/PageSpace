import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError, checkMCPPageScope, canPrincipalEditPage } from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { maskIdentifier } from '@/lib/logging/mask';
import {
  chatMessageRepository,
  processMessageContentUpdate,
} from '@/lib/repositories/chat-message-repository';
import { getActorInfo, logMessageActivity } from '@pagespace/lib/monitoring/activity-logger';
import { resolveTriggeredBy } from '@/lib/websocket/broadcast-triggered-by';
import { messageRepository } from '@/lib/repositories/message-repository';
import { getState, invalidate } from '@/lib/ai/core/compaction/compaction-repository';

const AUTH_OPTIONS = { allow: ['session', 'mcp'] as const, requireCSRF: true };

/**
 * PATCH - Edit a page agent conversation message's content
 * Updates the message text and sets editedAt timestamp
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ agentId: string; conversationId: string; messageId: string }> }
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) {
      auditRequest(request, { eventType: 'authz.access.denied', resourceType: 'page_agent_message', resourceId: 'edit', details: { reason: 'auth_failed', method: 'PATCH', authFailureReason: auth.authFailureReason }, riskScore: 0.5 });
      return auth.error;
    }
    const userId = auth.userId;

    const { agentId, conversationId, messageId } = await context.params;
    const { content } = await request.json();

    // Validate content
    if (!content || typeof content !== 'string') {
      return NextResponse.json(
        { error: 'Content is required and must be a string' },
        { status: 400 }
      );
    }

    // Check MCP page scope
    const scopeError = await checkMCPPageScope(auth, agentId);
    if (scopeError) {
      auditRequest(request, { eventType: 'authz.access.denied', userId, resourceType: 'page_agent_message', resourceId: messageId, details: { reason: 'mcp_page_scope_denied', agentId, conversationId, method: 'PATCH' }, riskScore: 0.5 });
      return scopeError;
    }

    // Check if user can edit the page (agent) this message belongs to
    const canEdit = await canPrincipalEditPage(auth, agentId);
    if (!canEdit) {
      loggers.api.warn('Edit agent message permission denied', {
        userId: maskIdentifier(userId),
        messageId: maskIdentifier(messageId),
        agentId: maskIdentifier(agentId),
      });
      auditRequest(request, { eventType: 'authz.access.denied', userId, resourceType: 'page_agent_message', resourceId: messageId, details: { reason: 'no_edit_permission', agentId, conversationId, method: 'PATCH' }, riskScore: 0.5 });
      return NextResponse.json(
        { error: 'You do not have permission to edit messages in this chat' },
        { status: 403 }
      );
    }

    // Get the message to verify it exists, is active, and belongs to this conversation
    const message = await chatMessageRepository.getMessageById(messageId);
    if (!message || !message.isActive) {
      return NextResponse.json({ error: 'Message not found' }, { status: 404 });
    }

    // Verify message belongs to this agent and conversation
    if (message.pageId !== agentId || message.conversationId !== conversationId) {
      return NextResponse.json({ error: 'Message not found in this conversation' }, { status: 404 });
    }

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
      pageId: agentId,
      conversationId,
      updatedContent,
      legacyTriggeredBy: await resolveTriggeredBy(userId, request),
    });

    // Invalidate compaction if the edited message was in the compacted range.
    // Awaited so the stale summary cannot be read by a concurrent request before we return.
    try {
      const state = await getState(conversationId, { source: 'page', pageId: agentId });
      // No row: a first compaction may be in flight — write the invalidation
      // tombstone so its pending insert loses. Row present: invalidate only
      // when the touched message is inside the compacted range.
      if (!state || (state.compactedUpToCreatedAt && message.createdAt <= state.compactedUpToCreatedAt)) {
        await invalidate(conversationId, { source: 'page', pageId: agentId });
      }
    } catch (err) {
      loggers.api.error('Failed to invalidate compaction state after agent message edit', err as Error);
    }

    // Log activity for audit trail
    try {
      const actorInfo = await getActorInfo(userId);
      logMessageActivity(userId, 'message_update', {
        id: messageId,
        pageId: agentId,
        driveId: null,
        conversationType: 'ai_chat',
      }, actorInfo, {
        previousContent: originalContent,
        newContent: updatedContent,
        aiConversationId: conversationId,
      });
    } catch (loggingError) {
      loggers.api.error('Failed to log agent message update activity', loggingError as Error, {
        messageId: maskIdentifier(messageId),
        agentId: maskIdentifier(agentId),
      });
    }

    loggers.api.info('Agent message edited successfully', {
      userId: maskIdentifier(userId),
      messageId: maskIdentifier(messageId),
      agentId: maskIdentifier(agentId),
      conversationId: maskIdentifier(conversationId),
    });

    auditRequest(request, { eventType: 'data.write', userId, resourceType: 'page_agent_message', resourceId: messageId, details: {
      action: 'edit_message',
      agentId,
      conversationId,
    } });

    return NextResponse.json({
      success: true,
      message: 'Message updated successfully',
    });
  } catch (error) {
    loggers.api.error('Error editing agent message', error as Error);
    return NextResponse.json(
      { error: 'Failed to edit message' },
      { status: 500 }
    );
  }
}

/**
 * DELETE - Soft delete a page agent conversation message
 * Sets isActive to false to hide the message
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ agentId: string; conversationId: string; messageId: string }> }
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) {
      auditRequest(request, { eventType: 'authz.access.denied', resourceType: 'page_agent_message', resourceId: 'delete', details: { reason: 'auth_failed', method: 'DELETE', authFailureReason: auth.authFailureReason }, riskScore: 0.5 });
      return auth.error;
    }
    const userId = auth.userId;

    const { agentId, conversationId, messageId } = await context.params;

    // Check MCP page scope
    const scopeError = await checkMCPPageScope(auth, agentId);
    if (scopeError) {
      auditRequest(request, { eventType: 'authz.access.denied', userId, resourceType: 'page_agent_message', resourceId: messageId, details: { reason: 'mcp_page_scope_denied', agentId, conversationId, method: 'DELETE' }, riskScore: 0.5 });
      return scopeError;
    }

    // Check if user can edit the page (agent) this message belongs to
    const canEdit = await canPrincipalEditPage(auth, agentId);
    if (!canEdit) {
      loggers.api.warn('Delete agent message permission denied', {
        userId: maskIdentifier(userId),
        messageId: maskIdentifier(messageId),
        agentId: maskIdentifier(agentId),
      });
      auditRequest(request, { eventType: 'authz.access.denied', userId, resourceType: 'page_agent_message', resourceId: messageId, details: { reason: 'no_edit_permission', agentId, conversationId, method: 'DELETE' }, riskScore: 0.5 });
      return NextResponse.json(
        { error: 'You do not have permission to delete messages in this chat' },
        { status: 403 }
      );
    }

    // Get the message to verify it exists, is active, and belongs to this conversation
    const message = await chatMessageRepository.getMessageById(messageId);
    if (!message || !message.isActive) {
      return NextResponse.json({ error: 'Message not found' }, { status: 404 });
    }

    // Verify message belongs to this agent and conversation
    if (message.pageId !== agentId || message.conversationId !== conversationId) {
      return NextResponse.json({ error: 'Message not found in this conversation' }, { status: 404 });
    }

    // Store content for audit trail before deletion
    const deletedContent = message.content;

    // Soft delete via the repository choke point (rev bump + legacy
    // chat:message_deleted + authoritative conversation:message_deleted).
    await messageRepository.softDeletePageMessage({
      messageId,
      pageId: agentId,
      conversationId,
      legacyTriggeredBy: await resolveTriggeredBy(userId, request),
    });

    // Invalidate compaction if the deleted message was in the compacted range.
    // Awaited so the stale summary cannot be read by a concurrent request before we return.
    try {
      const state = await getState(conversationId, { source: 'page', pageId: agentId });
      // No row: a first compaction may be in flight — write the invalidation
      // tombstone so its pending insert loses. Row present: invalidate only
      // when the touched message is inside the compacted range.
      if (!state || (state.compactedUpToCreatedAt && message.createdAt <= state.compactedUpToCreatedAt)) {
        await invalidate(conversationId, { source: 'page', pageId: agentId });
      }
    } catch (err) {
      loggers.api.error('Failed to invalidate compaction state after agent message delete', err as Error);
    }

    // Log activity for audit trail
    try {
      const actorInfo = await getActorInfo(userId);
      logMessageActivity(userId, 'message_delete', {
        id: messageId,
        pageId: agentId,
        driveId: null,
        conversationType: 'ai_chat',
      }, actorInfo, {
        previousContent: deletedContent,
        aiConversationId: conversationId,
      });
    } catch (loggingError) {
      loggers.api.error('Failed to log agent message deletion activity', loggingError as Error, {
        messageId: maskIdentifier(messageId),
        agentId: maskIdentifier(agentId),
      });
    }

    loggers.api.info('Agent message deleted successfully', {
      userId: maskIdentifier(userId),
      messageId: maskIdentifier(messageId),
      agentId: maskIdentifier(agentId),
      conversationId: maskIdentifier(conversationId),
    });

    auditRequest(request, { eventType: 'data.delete', userId, resourceType: 'page_agent_message', resourceId: messageId, details: {
      action: 'delete_message',
      agentId,
      conversationId,
    } });

    return NextResponse.json({
      success: true,
      message: 'Message deleted successfully',
    });
  } catch (error) {
    loggers.api.error('Error deleting agent message', error as Error);
    return NextResponse.json(
      { error: 'Failed to delete message' },
      { status: 500 }
    );
  }
}
