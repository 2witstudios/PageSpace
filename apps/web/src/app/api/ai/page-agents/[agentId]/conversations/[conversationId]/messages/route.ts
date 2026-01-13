import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db, chatMessages, pages, eq, and, desc, gt, lt } from '@pagespace/db';
import { canUserViewPage } from '@pagespace/lib/server';
import { convertDbMessageToUIMessage } from '@/lib/ai/core';
import { loggers } from '@pagespace/lib/server';

// Auth options: GET is read-only operation
const AUTH_OPTIONS_READ = { allow: ['jwt', 'mcp'] as const, requireCSRF: false };

/**
 * GET /api/ai/page-agents/[agentId]/conversations/[conversationId]/messages
 *
 * Retrieves messages for a specific conversation session with optional cursor-based pagination.
 * Messages are returned in UIMessage format compatible with the Vercel AI SDK,
 * including tool calls and tool results if present.
 *
 * @param agentId - The unique identifier of the AI agent (AI_CHAT page ID)
 * @param conversationId - The unique identifier of the conversation session
 *
 * Query Parameters:
 *   - limit (optional): Max messages to return (default 50, max 200)
 *   - cursor (optional): Message ID for cursor-based pagination
 *   - direction (optional): 'before' (older) or 'after' (newer), default 'before'
 *
 * @returns {object} Response object containing:
 *   - messages: Array of UIMessage objects with:
 *     - id: Message identifier
 *     - role: 'user' | 'assistant' | 'system'
 *     - parts: Array of message parts (text, tool-call, tool-result)
 *     - createdAt: Message timestamp
 *   - conversationId: The conversation identifier (for verification)
 *   - messageCount: Total number of messages in the conversation (deprecated, use pagination)
 *   - pagination: { hasMore, nextCursor, prevCursor, limit, direction }
 *
 * @throws {403} If user doesn't have view permission for the agent
 * @throws {404} If agent or conversation doesn't exist
 * @throws {500} If database query fails
 *
 * @example
 * GET /api/ai/page-agents/abc123/conversations/conv_xyz789/messages?limit=50
 * Response: {
 *   messages: [
 *     { id: "msg1", role: "user", parts: [{type: "text", text: "Hello"}], createdAt: "..." },
 *     { id: "msg2", role: "assistant", parts: [{type: "text", text: "Hi!"}], createdAt: "..." }
 *   ],
 *   conversationId: "conv_xyz789",
 *   messageCount: 2,
 *   pagination: { hasMore: false, nextCursor: null, prevCursor: "msg2", limit: 50, direction: "before" }
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

    // Parse pagination parameters
    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 200);
    const cursor = searchParams.get('cursor'); // Message ID for cursor-based pagination
    const direction = searchParams.get('direction') || 'before'; // 'before' or 'after'

    // Build query conditions
    const conditions = [
      eq(chatMessages.pageId, agentId),
      eq(chatMessages.conversationId, conversationId),
      eq(chatMessages.isActive, true)
    ];

    // Add cursor condition if provided
    if (cursor) {
      // First, get the timestamp of the cursor message
      const cursorMessage = await db.query.chatMessages.findFirst({
        where: eq(chatMessages.id, cursor),
        columns: { createdAt: true }
      });

      if (cursorMessage) {
        if (direction === 'before') {
          // Get messages created before the cursor (older messages)
          conditions.push(lt(chatMessages.createdAt, cursorMessage.createdAt));
        } else {
          // Get messages created after the cursor (newer messages)
          conditions.push(gt(chatMessages.createdAt, cursorMessage.createdAt));
        }
      }
    }

    // Get messages with pagination
    // Order by createdAt DESC to get newest first, then reverse for chronological display
    const dbMessages = await db
      .select()
      .from(chatMessages)
      .where(and(...conditions))
      .orderBy(desc(chatMessages.createdAt))
      .limit(limit + 1); // Get one extra to check if there are more

    // Check if there are more messages
    const hasMore = dbMessages.length > limit;
    const messagesToReturn = hasMore ? dbMessages.slice(0, limit) : dbMessages;

    // Reverse messages to show in chronological order (oldest first)
    const orderedMessages = messagesToReturn.reverse();

    // Convert to UIMessage format
    const messages = orderedMessages.map(convertDbMessageToUIMessage);

    // Determine cursors for pagination
    const nextCursor = hasMore && orderedMessages.length > 0
      ? orderedMessages[0].id // First message (oldest) for loading even older messages
      : null;

    const prevCursor = orderedMessages.length > 0
      ? orderedMessages[orderedMessages.length - 1].id // Last message (newest) for loading newer messages
      : null;

    return NextResponse.json({
      messages,
      conversationId,
      messageCount: messages.length,
      pagination: {
        hasMore,
        nextCursor,
        prevCursor,
        limit,
        direction
      }
    });

  } catch (error) {
    loggers.ai.error('Error loading conversation messages:', error as Error);
    return NextResponse.json(
      { error: 'Failed to load conversation messages' },
      { status: 500 }
    );
  }
}
