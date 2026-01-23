import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { canUserEditPage } from '@pagespace/lib/server';
import { loggers } from '@pagespace/lib/server';
import { maskIdentifier } from '@/lib/logging/mask';
import {
  chatMessageRepository,
  processMessageContentUpdate,
} from '@/lib/repositories/chat-message-repository';
import { db, pages, eq } from '@pagespace/db';
import { getActorInfo, logMessageActivity } from '@pagespace/lib/monitoring/activity-logger';

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
    if (isAuthError(auth)) return auth.error;
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

    // Check if user can edit the page this message belongs to
    const canEdit = await canUserEditPage(userId, message.pageId);
    if (!canEdit) {
      loggers.api.warn('Edit message permission denied', {
        userId: maskIdentifier(userId),
        messageId: maskIdentifier(messageId),
        pageId: maskIdentifier(message.pageId)
      });
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
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const { messageId } = await context.params;

    // Get the message to check permissions
    const message = await chatMessageRepository.getMessageById(messageId);

    if (!message) {
      return NextResponse.json({ error: 'Message not found' }, { status: 404 });
    }

    // Check if user can edit the page this message belongs to
    const canEdit = await canUserEditPage(userId, message.pageId);
    if (!canEdit) {
      loggers.api.warn('Delete message permission denied', {
        userId: maskIdentifier(userId),
        messageId: maskIdentifier(messageId),
        pageId: maskIdentifier(message.pageId)
      });
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
