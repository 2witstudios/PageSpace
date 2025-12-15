import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/server';
import { maskIdentifier } from '@/lib/logging/mask';
import {
  globalConversationRepository,
  processMessageContentUpdate,
} from '@/lib/repositories/global-conversation-repository';

const AUTH_OPTIONS = { allow: ['jwt'] as const, requireCSRF: true };

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

    // Process content update (preserving structure if needed)
    const updatedContent = processMessageContentUpdate(message.content, content);

    // Update the message content
    await globalConversationRepository.updateMessageContent(messageId, updatedContent);

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

    // Soft delete the message
    await globalConversationRepository.softDeleteMessage(messageId);

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
