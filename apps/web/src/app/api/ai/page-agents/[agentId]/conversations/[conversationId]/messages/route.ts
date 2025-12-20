import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db, chatMessages, pages, eq, and } from '@pagespace/db';
import { canUserViewPage } from '@pagespace/lib/server';
import { convertDbMessageToUIMessage } from '@/lib/ai/core';
import { loggers } from '@pagespace/lib/server';

// Auth options: GET is read-only operation
const AUTH_OPTIONS_READ = { allow: ['jwt', 'mcp'] as const, requireCSRF: false };

/**
 * GET /api/ai/page-agents/[agentId]/conversations/[conversationId]/messages
 *
 * Retrieves all messages for a specific conversation session, ordered chronologically.
 * Messages are returned in UIMessage format compatible with the Vercel AI SDK,
 * including tool calls and tool results if present.
 *
 * @param agentId - The unique identifier of the AI agent (AI_CHAT page ID)
 * @param conversationId - The unique identifier of the conversation session
 *
 * @returns {object} Response object containing:
 *   - messages: Array of UIMessage objects with:
 *     - id: Message identifier
 *     - role: 'user' | 'assistant' | 'system'
 *     - parts: Array of message parts (text, tool-call, tool-result)
 *     - createdAt: Message timestamp
 *   - conversationId: The conversation identifier (for verification)
 *   - messageCount: Total number of messages in the conversation
 *
 * @throws {403} If user doesn't have view permission for the agent
 * @throws {404} If agent or conversation doesn't exist
 * @throws {500} If database query fails
 *
 * @example
 * GET /api/ai/page-agents/abc123/conversations/conv_xyz789/messages
 * Response: {
 *   messages: [
 *     { id: "msg1", role: "user", parts: [{type: "text", text: "Hello"}], createdAt: "..." },
 *     { id: "msg2", role: "assistant", parts: [{type: "text", text: "Hi!"}], createdAt: "..." }
 *   ],
 *   conversationId: "conv_xyz789",
 *   messageCount: 2
 * }
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ agentId: string; conversationId: string }> }
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
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

    // Check permissions
    const canView = await canUserViewPage(auth.userId, agentId);
    if (!canView) {
      return NextResponse.json(
        { error: 'Insufficient permissions to view this agent\'s conversations' },
        { status: 403 }
      );
    }

    // Query messages for this conversation
    const dbMessages = await db
      .select()
      .from(chatMessages)
      .where(and(
        eq(chatMessages.pageId, agentId),
        eq(chatMessages.conversationId, conversationId),
        eq(chatMessages.isActive, true)
      ))
      .orderBy(chatMessages.createdAt);

    // Convert to UIMessage format
    const messages = dbMessages.map(convertDbMessageToUIMessage);

    return NextResponse.json({
      messages,
      conversationId,
      messageCount: messages.length,
    });

  } catch (error) {
    loggers.ai.error('Error loading conversation messages:', error as Error);
    return NextResponse.json(
      { error: 'Failed to load conversation messages' },
      { status: 500 }
    );
  }
}
