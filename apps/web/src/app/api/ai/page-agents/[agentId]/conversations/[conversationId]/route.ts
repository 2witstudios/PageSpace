import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError, checkMCPPageScope } from '@/lib/auth';
import { canUserEditPage, conversationCache } from '@pagespace/lib/server';
import { loggers } from '@pagespace/lib/server';
import { conversationRepository } from '@/lib/repositories/conversation-repository';

// Auth options: PATCH and DELETE are write operations requiring CSRF protection
const AUTH_OPTIONS_WRITE = { allow: ['session', 'mcp'] as const, requireCSRF: true };

/**
 * PATCH /api/ai/page-agents/[agentId]/conversations/[conversationId]
 *
 * Updates conversation metadata such as title. Persists the title to the
 * conversations table via upsert (insert or update).
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ agentId: string; conversationId: string }> }
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
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

    // Check MCP page scope
    const scopeError = await checkMCPPageScope(auth, agentId);
    if (scopeError) return scopeError;

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

    if (typeof title !== 'string' || title.trim().length === 0) {
      return NextResponse.json(
        { error: 'Title is required and must be a non-empty string' },
        { status: 400 }
      );
    }

    if (title.length > 255) {
      return NextResponse.json(
        { error: 'Title must be 255 characters or fewer' },
        { status: 400 }
      );
    }

    // Validate that the conversation exists (has at least one active message)
    const exists = await conversationRepository.conversationExists(agentId, conversationId);

    if (!exists) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      );
    }

    // Persist the title via upsert into the conversations table
    const persisted = await conversationRepository.upsertConversationTitle(
      conversationId,
      auth.userId,
      agentId,
      title
    );

    return NextResponse.json({
      success: true,
      conversationId: persisted.id,
      title: persisted.title,
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
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
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

    // Check MCP page scope
    const scopeError = await checkMCPPageScope(auth, agentId);
    if (scopeError) return scopeError;

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

    // Invalidate conversation cache
    await conversationCache.invalidateConversation(agentId, conversationId);

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
