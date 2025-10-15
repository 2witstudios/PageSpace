import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db, chatMessages, eq } from '@pagespace/db';
import { canUserEditPage } from '@pagespace/lib/server';
import { loggers } from '@pagespace/lib/server';
import { maskIdentifier } from '@/lib/logging/mask';

const AUTH_OPTIONS = { allow: ['jwt', 'mcp'] as const, requireCSRF: true };

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
    const [message] = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.id, messageId));

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

    // Parse existing content to check if it's structured
    let updatedContent = content;
    try {
      const parsed = JSON.parse(message.content);
      if (parsed.textParts && parsed.partsOrder) {
        // Update only textParts, preserve structure
        parsed.textParts = [content];
        parsed.originalContent = content;
        updatedContent = JSON.stringify(parsed);
      }
    } catch {
      // Plain text, use as-is
    }

    // Update the message content and set editedAt
    await db
      .update(chatMessages)
      .set({
        content: updatedContent,
        editedAt: new Date()
      })
      .where(eq(chatMessages.id, messageId));

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
    const [message] = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.id, messageId));

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

    // Soft delete the message
    await db
      .update(chatMessages)
      .set({ isActive: false })
      .where(eq(chatMessages.id, messageId));

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
