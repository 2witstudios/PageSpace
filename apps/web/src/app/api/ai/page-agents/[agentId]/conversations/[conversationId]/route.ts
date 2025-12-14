import { NextResponse } from 'next/server';
import { authenticateHybridRequest, isAuthError } from '@/lib/auth';
import { canUserEditPage } from '@pagespace/lib/server';
import { loggers } from '@pagespace/lib/server';
import { conversationRepository } from '@/lib/repositories/conversation-repository';

/**
 * PATCH /api/ai/page-agents/[agentId]/conversations/[conversationId]
 *
 * Updates conversation metadata such as title. This is currently a placeholder endpoint
 * that validates the conversation exists but does not persist custom titles.
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
    const agent = await conversationRepository.getAiAgent(agentId);

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

    // Validate that the conversation exists
    const exists = await conversationRepository.conversationExists(agentId, conversationId);

    if (!exists) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      );
    }

    // Note: Currently we don't persist custom titles
    // This could be extended to update a separate conversations table
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
 * DELETE /api/ai/page-agents/[agentId]/conversations/[conversationId]
 *
 * Soft-deletes a conversation by marking all its messages as inactive.
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
    const agent = await conversationRepository.getAiAgent(agentId);

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

    // Verify conversation exists before attempting deletion
    const exists = await conversationRepository.conversationExists(agentId, conversationId);
    if (!exists) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      );
    }

    // Get conversation metadata before deletion for audit log
    const metadata = await conversationRepository.getConversationMetadata(agentId, conversationId);

    // Soft-delete all messages in the conversation
    await conversationRepository.softDeleteConversation(agentId, conversationId);

    // Audit log the deletion for security and compliance
    await conversationRepository.logConversationDeletion({
      userId: auth.userId,
      conversationId,
      agentId,
      metadata,
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
