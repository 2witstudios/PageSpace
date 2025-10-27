import { NextResponse } from 'next/server';
import { authenticateHybridRequest, isAuthError } from '@/lib/auth';
import { db, chatMessages, pages, userActivities, eq, and, sql } from '@pagespace/db';
import { canUserEditPage } from '@pagespace/lib/server';
import { loggers } from '@pagespace/lib/server';

/**
 * PATCH /api/agents/[agentId]/conversations/[conversationId]
 *
 * Updates conversation metadata such as title. This is currently a placeholder endpoint
 * that validates the conversation exists but does not persist custom titles. In a future
 * implementation, this will update a separate conversations table to store custom metadata.
 *
 * @param agentId - The unique identifier of the AI agent (AI_CHAT page ID)
 * @param conversationId - The unique identifier of the conversation session to update
 * @param request.body - JSON body with optional fields:
 *   - title: Custom title for the conversation (not currently persisted)
 *
 * @returns {object} Response object containing:
 *   - success: Boolean indicating operation status
 *   - conversationId: The conversation identifier
 *   - title: The title from the request
 *   - message: Info message about future support
 *
 * @throws {400} If request body is malformed
 * @throws {403} If user doesn't have edit permission for the agent
 * @throws {404} If agent or conversation doesn't exist
 * @throws {500} If database query fails
 *
 * @example
 * PATCH /api/agents/abc123/conversations/conv_xyz789
 * Body: { "title": "My Custom Title" }
 * Response: {
 *   success: true,
 *   conversationId: "conv_xyz789",
 *   title: "My Custom Title",
 *   message: "Custom titles will be supported in a future update"
 * }
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ agentId: string; conversationId: string }> }
) {
  try {
    const auth = await authenticateHybridRequest(request);
    if (isAuthError(auth)) return auth.error;

    const { agentId, conversationId } = await context.params;

    // Verify agent exists and is AI_CHAT type
    const agent = await db.query.pages.findFirst({
      where: and(
        eq(pages.id, agentId),
        eq(pages.type, 'AI_CHAT'),
        eq(pages.isTrashed, false)
      ),
    });

    if (!agent) {
      return NextResponse.json(
        { error: 'AI agent not found' },
        { status: 404 }
      );
    }

    // Check permissions (need edit to modify conversations)
    const canEdit = await canUserEditPage(auth.userId, agentId);
    if (!canEdit) {
      return NextResponse.json(
        { error: 'Insufficient permissions to modify this conversation' },
        { status: 403 }
      );
    }

    // Parse request body
    const body = await request.json();
    const { title } = body;

    // For now, just validate that the conversation exists
    const conversationMessages = await db
      .select({ count: chatMessages.id })
      .from(chatMessages)
      .where(and(
        eq(chatMessages.pageId, agentId),
        eq(chatMessages.conversationId, conversationId),
        eq(chatMessages.isActive, true)
      ))
      .limit(1);

    if (conversationMessages.length === 0) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      );
    }

    // Note: Currently we don't persist custom titles
    // This could be extended to update a separate conversations table
    // For now, just return success
    return NextResponse.json({
      success: true,
      conversationId,
      title,
      message: 'Custom titles will be supported in a future update',
    });

  } catch (error) {
    loggers.ai.error('Error updating conversation:', error as Error);
    return NextResponse.json(
      { error: 'Failed to update conversation' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/agents/[agentId]/conversations/[conversationId]
 *
 * Soft-deletes a conversation by marking all its messages as inactive. This operation
 * preserves the data in the database but hides it from all queries that filter by
 * isActive=true. The conversation will no longer appear in conversation listings or
 * message queries. This is a destructive operation that requires edit permissions.
 *
 * @param agentId - The unique identifier of the AI agent (AI_CHAT page ID)
 * @param conversationId - The unique identifier of the conversation session to delete
 *
 * @returns {object} Response object containing:
 *   - success: Boolean indicating operation status
 *   - conversationId: The conversation identifier that was deleted
 *   - message: Success message confirming deletion
 *
 * @throws {403} If user doesn't have edit permission for the agent
 * @throws {404} If agent doesn't exist or isn't AI_CHAT type
 * @throws {500} If database update fails
 *
 * @example
 * DELETE /api/agents/abc123/conversations/conv_xyz789
 * Response: {
 *   success: true,
 *   conversationId: "conv_xyz789",
 *   message: "Conversation deleted successfully"
 * }
 *
 * @note This is a soft-delete operation. Messages remain in the database with
 * isActive=false and could be restored by an admin if needed. For true data deletion,
 * a separate hard-delete operation would be required.
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ agentId: string; conversationId: string }> }
) {
  try {
    const auth = await authenticateHybridRequest(request);
    if (isAuthError(auth)) return auth.error;

    const { agentId, conversationId } = await context.params;

    // Verify agent exists and is AI_CHAT type
    const agent = await db.query.pages.findFirst({
      where: and(
        eq(pages.id, agentId),
        eq(pages.type, 'AI_CHAT'),
        eq(pages.isTrashed, false)
      ),
    });

    if (!agent) {
      return NextResponse.json(
        { error: 'AI agent not found' },
        { status: 404 }
      );
    }

    // Check permissions (need edit to delete conversations)
    const canEdit = await canUserEditPage(auth.userId, agentId);
    if (!canEdit) {
      return NextResponse.json(
        { error: 'Insufficient permissions to delete this conversation' },
        { status: 403 }
      );
    }

    // Get conversation metadata before deletion for audit log
    const conversationMetadata = await db
      .select({
        messageCount: sql<number>`COUNT(*)`.as('messageCount'),
        firstMessageTime: sql<Date>`MIN(created_at)`.as('firstMessageTime'),
        lastMessageTime: sql<Date>`MAX(created_at)`.as('lastMessageTime'),
      })
      .from(chatMessages)
      .where(and(
        eq(chatMessages.pageId, agentId),
        eq(chatMessages.conversationId, conversationId),
        eq(chatMessages.isActive, true)
      ));

    const metadata = conversationMetadata[0];

    // Soft-delete all messages in the conversation
    await db
      .update(chatMessages)
      .set({ isActive: false })
      .where(and(
        eq(chatMessages.pageId, agentId),
        eq(chatMessages.conversationId, conversationId)
      ));

    // Audit log the deletion for security and compliance
    await db.insert(userActivities).values({
      userId: auth.userId,
      action: 'delete',
      resource: 'conversation',
      resourceId: conversationId,
      pageId: agentId,
      metadata: {
        conversationId,
        agentId,
        messageCount: metadata?.messageCount || 0,
        firstMessageTime: metadata?.firstMessageTime,
        lastMessageTime: metadata?.lastMessageTime,
        deletionReason: 'user_initiated',
      },
    });

    loggers.ai.info('Conversation deleted', {
      conversationId,
      agentId,
      userId: auth.userId,
      messageCount: metadata?.messageCount || 0,
    });

    return NextResponse.json({
      success: true,
      conversationId,
      message: 'Conversation deleted successfully',
    });

  } catch (error) {
    loggers.ai.error('Error deleting conversation:', error as Error);
    return NextResponse.json(
      { error: 'Failed to delete conversation' },
      { status: 500 }
    );
  }
}
