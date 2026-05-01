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
import { getActorInfo, logMessageActivity } from '@pagespace/lib/monitoring/activity-logger';
import { broadcastAiMessageEdited, broadcastAiMessageDeleted } from '@/lib/websocket/socket-utils';
import { resolveTriggeredBy } from '@/lib/websocket/broadcast-triggered-by';
import { convertDbMessageToUIMessage } from '@/lib/ai/core/message-utils';

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
      auditRequest(request, { eventType: 'authz.access.denied', resourceType: 'page_agent_message', resourceId: 'edit', details: { reason: 'auth_failed', method: 'PATCH' }, riskScore: 0.5 });
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
    const canEdit = await canUserEditPage(userId, agentId);
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

    // Update the message content and set editedAt
    await chatMessageRepository.updateMessageContent(messageId, updatedContent);

    // Broadcast to remote viewers so their message bubble re-renders without a refetch.
    // Failure to broadcast must never break the request — wrapped in catch.
    void (async () => {
      try {
        const updated = await chatMessageRepository.getMessageById(messageId);
        if (!updated) return;
        const triggeredBy = await resolveTriggeredBy(userId, request);
        const uiMessage = convertDbMessageToUIMessage(updated);
        await broadcastAiMessageEdited({
          messageId,
          pageId: agentId,
          conversationId,
          parts: uiMessage.parts,
          editedAt: (updated.editedAt ?? new Date()).toISOString(),
          triggeredBy,
        });
      } catch (broadcastError) {
        loggers.api.error('Failed to broadcast agent message edit', broadcastError as Error, {
          messageId: maskIdentifier(messageId),
          agentId: maskIdentifier(agentId),
        });
      }
    })();

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
      auditRequest(request, { eventType: 'authz.access.denied', resourceType: 'page_agent_message', resourceId: 'delete', details: { reason: 'auth_failed', method: 'DELETE' }, riskScore: 0.5 });
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
    const canEdit = await canUserEditPage(userId, agentId);
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

    // Soft delete the message
    await chatMessageRepository.softDeleteMessage(messageId);

    // Broadcast to remote viewers. Failure must never break the request.
    void (async () => {
      try {
        const triggeredBy = await resolveTriggeredBy(userId, request);
        await broadcastAiMessageDeleted({
          messageId,
          pageId: agentId,
          conversationId,
          triggeredBy,
        });
      } catch (broadcastError) {
        loggers.api.error('Failed to broadcast agent message delete', broadcastError as Error, {
          messageId: maskIdentifier(messageId),
          agentId: maskIdentifier(agentId),
        });
      }
    })();

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
