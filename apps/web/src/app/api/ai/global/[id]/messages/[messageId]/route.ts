import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/server';
import { maskIdentifier } from '@/lib/logging/mask';
import { globalConversationRepository } from '@/lib/repositories/global-conversation-repository';
import { processMessageContentUpdate } from '@/lib/repositories/chat-message-repository';
import { getActorInfo, logMessageActivity } from '@pagespace/lib/monitoring/activity-logger';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

/**
 * PATCH - Edit message content
 * Updates a conversation message's content and sets editedAt timestamp
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string; messageId: string }> }
) {
  try {
    // Authenticate
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const { id: conversationId, messageId } = await context.params;
    const { content } = await request.json();

    // Validate content
    if (!content || typeof content !== 'string') {
      return NextResponse.json(
        { error: 'Content is required and must be a string' },
        { status: 400 }
      );
    }

    // Verify user owns the conversation
    const conversation = await globalConversationRepository.getConversationById(userId, conversationId);
    if (!conversation) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      );
    }

    // Get the message to verify it belongs to this conversation
    const message = await globalConversationRepository.getMessageById(conversationId, messageId);
    if (!message) {
      return NextResponse.json({ error: 'Message not found' }, { status: 404 });
    }

    // Store original content for activity logging
    const originalContent = message.content;

    // Process content update (preserving structure if needed)
    const updatedContent = processMessageContentUpdate(message.content, content);

    // Update the message content
    await globalConversationRepository.updateMessageContent(messageId, updatedContent);

    // Log activity for audit trail (non-blocking)
    try {
      const actorInfo = await getActorInfo(userId);
      logMessageActivity(userId, 'message_update', {
        id: messageId,
        pageId: conversationId, // Global conversations use conversationId as identifier
        driveId: null, // Global conversations are user-level, not drive-level
        conversationType: 'global',
      }, actorInfo, {
        previousContent: originalContent,
        newContent: updatedContent,
        aiConversationId: conversationId,
      });
    } catch (loggingError) {
      loggers.api.error('Failed to log message update activity', loggingError as Error, {
        messageId: maskIdentifier(messageId),
        conversationId: maskIdentifier(conversationId)
      });
    }

    loggers.api.info('Global Assistant message edited successfully', {
      userId: maskIdentifier(userId),
      messageId: maskIdentifier(messageId),
      conversationId: maskIdentifier(conversationId)
    });

    return NextResponse.json({
      success: true,
      message: 'Message updated successfully'
    });
  } catch (error) {
    loggers.api.error('Error editing Global Assistant message', error as Error);
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
  context: { params: Promise<{ id: string; messageId: string }> }
) {
  try {
    // Authenticate
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const { id: conversationId, messageId } = await context.params;

    // Verify user owns the conversation
    const conversation = await globalConversationRepository.getConversationById(userId, conversationId);
    if (!conversation) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      );
    }

    // Get the message to verify it belongs to this conversation
    const message = await globalConversationRepository.getMessageById(conversationId, messageId);
    if (!message) {
      return NextResponse.json({ error: 'Message not found' }, { status: 404 });
    }

    // Store content for audit trail before deletion
    const deletedContent = message.content;

    // Soft delete the message
    await globalConversationRepository.softDeleteMessage(messageId);

    // Log activity for audit trail (non-blocking)
    try {
      const actorInfo = await getActorInfo(userId);
      logMessageActivity(userId, 'message_delete', {
        id: messageId,
        pageId: conversationId, // Global conversations use conversationId as identifier
        driveId: null, // Global conversations are user-level, not drive-level
        conversationType: 'global',
      }, actorInfo, {
        previousContent: deletedContent,
        aiConversationId: conversationId,
      });
    } catch (loggingError) {
      loggers.api.error('Failed to log message deletion activity', loggingError as Error, {
        messageId: maskIdentifier(messageId),
        conversationId: maskIdentifier(conversationId)
      });
    }

    loggers.api.info('Global Assistant message deleted successfully', {
      userId: maskIdentifier(userId),
      messageId: maskIdentifier(messageId),
      conversationId: maskIdentifier(conversationId)
    });

    return NextResponse.json({
      success: true,
      message: 'Message deleted successfully'
    });
  } catch (error) {
    loggers.api.error('Error deleting Global Assistant message', error as Error);
    return NextResponse.json(
      { error: 'Failed to delete message' },
      { status: 500 }
    );
  }
}
