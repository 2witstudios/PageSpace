import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { canUserEditPage } from '@pagespace/lib/server';
import { loggers } from '@pagespace/lib/server';
import { maskIdentifier } from '@/lib/logging/mask';
import {
  chatMessageRepository,
  processMessageContentUpdate,
} from '@/lib/repositories/chat-message-repository';
import { getActorInfo, logMessageActivity } from '@pagespace/lib/monitoring/activity-logger';

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
    if (isAuthError(auth)) return auth.error;
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

    // Check if user can edit the page (agent) this message belongs to
    const canEdit = await canUserEditPage(userId, agentId);
    if (!canEdit) {
      loggers.api.warn('Edit agent message permission denied', {
        userId: maskIdentifier(userId),
        messageId: maskIdentifier(messageId),
        agentId: maskIdentifier(agentId),
      });
      return NextResponse.json(
        { error: 'You do not have permission to edit messages in this chat' },
        { status: 403 }
      );
    }

    // Get the message to verify it exists and belongs to this conversation
    const message = await chatMessageRepository.getMessageById(messageId);
    if (!message) {
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

    // Log activity for audit trail (non-blocking)
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
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const { agentId, conversationId, messageId } = await context.params;

    // Check if user can edit the page (agent) this message belongs to
    const canEdit = await canUserEditPage(userId, agentId);
    if (!canEdit) {
      loggers.api.warn('Delete agent message permission denied', {
        userId: maskIdentifier(userId),
        messageId: maskIdentifier(messageId),
        agentId: maskIdentifier(agentId),
      });
      return NextResponse.json(
        { error: 'You do not have permission to delete messages in this chat' },
        { status: 403 }
      );
    }

    // Get the message to verify it exists and belongs to this conversation
    const message = await chatMessageRepository.getMessageById(messageId);
    if (!message) {
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

    // Log activity for audit trail (non-blocking)
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
