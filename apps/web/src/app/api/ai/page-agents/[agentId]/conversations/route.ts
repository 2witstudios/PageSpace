import { NextResponse } from 'next/server';
import { authenticateHybridRequest, isAuthError } from '@/lib/auth';
import { db, chatMessages, pages, eq, and, sql } from '@pagespace/db';
import { canUserViewPage } from '@pagespace/lib/server';
import { loggers } from '@pagespace/lib/server';

/**
 * GET /api/ai/page-agents/[agentId]/conversations
 *
 * Lists all conversations for a specific AI agent with pagination support.
 * Returns conversations in reverse chronological order (most recent first).
 * Each conversation includes metadata such as title, preview, message count,
 * and timestamp information.
 *
 * @param agentId - The unique identifier of the AI agent (AI_CHAT page ID)
 * @param page - Optional query parameter: Page number (0-indexed, default: 0)
 * @param pageSize - Optional query parameter: Number of conversations per page (default: 50, max: 100)
 *
 * @returns {object} Response object containing:
 *   - conversations: Array of conversation metadata objects with:
 *     - id: Unique conversation identifier
 *     - title: Auto-generated or custom conversation title
 *     - preview: Text preview of first user message
 *     - createdAt: Timestamp of first message
 *     - updatedAt: Timestamp of last message
 *     - messageCount: Total number of messages in conversation
 *     - lastMessage: Info about the most recent message
 *   - pagination: Object with page, pageSize, totalCount, totalPages, hasMore
 *
 * @throws {400} If agentId is invalid or missing
 * @throws {403} If user doesn't have view permission for the agent
 * @throws {404} If agent doesn't exist or isn't AI_CHAT type
 * @throws {500} If database query fails
 *
 * @example
 * GET /api/ai/page-agents/abc123/conversations?page=0&pageSize=20
 * Response: {
 *   conversations: [{
 *     id: "conv_xyz789",
 *     title: "How to implement authentication...",
 *     preview: "How to implement authentication in Next.js 15?",
 *     createdAt: "2025-10-26T10:30:00Z",
 *     updatedAt: "2025-10-26T11:45:00Z",
 *     messageCount: 8,
 *     lastMessage: { role: "assistant", timestamp: "2025-10-26T11:45:00Z" }
 *   }],
 *   pagination: { page: 0, pageSize: 20, totalCount: 42, totalPages: 3, hasMore: true }
 * }
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ agentId: string }> }
) {
  try {
    const auth = await authenticateHybridRequest(request);
    if (isAuthError(auth)) return auth.error;

    const { agentId } = await context.params;

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
        { error: 'Insufficient permissions to view this agent' },
        { status: 403 }
      );
    }

    // Get URL params for pagination
    const { searchParams } = new URL(request.url);
    const page = parseInt(searchParams.get('page') || '0', 10);
    const pageSize = parseInt(searchParams.get('pageSize') || '50', 10);
    const offset = page * pageSize;

    // Query conversations with optimized window functions to avoid N+1 queries
    // Uses CTEs and window functions to fetch all message data in a single pass
    const conversationsQuery = await db.execute<{
      conversationId: string;
      firstMessageTime: Date;
      lastMessageTime: Date;
      messageCount: number;
      firstUserMessage: string | null;
      lastMessageRole: string | null;
      lastMessageContent: string | null;
    }>(sql`
      WITH ranked_messages AS (
        SELECT
          "conversationId",
          content,
          role,
          "createdAt",
          ROW_NUMBER() OVER (
            PARTITION BY "conversationId", role
            ORDER BY "createdAt" ASC
          ) as first_user_msg_rank,
          ROW_NUMBER() OVER (
            PARTITION BY "conversationId"
            ORDER BY "createdAt" DESC
          ) as last_msg_rank
        FROM chat_messages
        WHERE "pageId" = ${agentId}
          AND "isActive" = true
      ),
      conversation_stats AS (
        SELECT
          "conversationId",
          MIN("createdAt") as first_message_time,
          MAX("createdAt") as last_message_time,
          COUNT(*) as message_count
        FROM chat_messages
        WHERE "pageId" = ${agentId}
          AND "isActive" = true
        GROUP BY "conversationId"
      ),
      first_user_messages AS (
        SELECT "conversationId", content as first_user_message
        FROM ranked_messages
        WHERE role = 'user' AND first_user_msg_rank = 1
      ),
      last_messages AS (
        SELECT
          "conversationId",
          role as last_message_role,
          content as last_message_content
        FROM ranked_messages
        WHERE last_msg_rank = 1
      )
      SELECT
        cs."conversationId" as "conversationId",
        cs.first_message_time as "firstMessageTime",
        cs.last_message_time as "lastMessageTime",
        cs.message_count as "messageCount",
        fum.first_user_message as "firstUserMessage",
        lm.last_message_role as "lastMessageRole",
        lm.last_message_content as "lastMessageContent"
      FROM conversation_stats cs
      LEFT JOIN first_user_messages fum ON cs."conversationId" = fum."conversationId"
      LEFT JOIN last_messages lm ON cs."conversationId" = lm."conversationId"
      ORDER BY cs.last_message_time DESC
      LIMIT ${pageSize}
      OFFSET ${offset}
    `);

    const conversationsArray = conversationsQuery.rows;

    // Format conversations for response
    const conversations = conversationsArray.map(conv => {
      // Extract text from first user message (it's stored as JSON with parts)
      let preview = 'New conversation';
      try {
        if (conv.firstUserMessage) {
          const parsed = JSON.parse(conv.firstUserMessage);
          if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].text) {
            preview = parsed[0].text.substring(0, 100);
          } else if (typeof parsed === 'object' && parsed.parts?.[0]?.text) {
            preview = parsed.parts[0].text.substring(0, 100);
          }
        }
      } catch {
        // If parsing fails, use raw content substring
        if (conv.firstUserMessage) {
          preview = conv.firstUserMessage.substring(0, 100);
        }
      }

      // Generate title from preview
      const title = preview.length > 50
        ? preview.substring(0, 50) + '...'
        : preview;

      return {
        id: conv.conversationId,
        title,
        preview,
        createdAt: conv.firstMessageTime,
        updatedAt: conv.lastMessageTime,
        messageCount: Number(conv.messageCount),
        lastMessage: {
          role: conv.lastMessageRole,
          timestamp: conv.lastMessageTime,
        },
      };
    });

    // Get total count for pagination
    const totalCountResult = await db
      .select({
        count: sql<number>`COUNT(DISTINCT ${chatMessages.conversationId})`,
      })
      .from(chatMessages)
      .where(and(
        eq(chatMessages.pageId, agentId),
        eq(chatMessages.isActive, true)
      ));

    const totalCount = Number(totalCountResult[0]?.count || 0);

    return NextResponse.json({
      conversations,
      pagination: {
        page,
        pageSize,
        totalCount,
        totalPages: Math.ceil(totalCount / pageSize),
        hasMore: (page + 1) * pageSize < totalCount,
      },
    });

  } catch (error) {
    loggers.ai.error('Error listing conversations:', error as Error);
    return NextResponse.json(
      { error: 'Failed to list conversations' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/ai/page-agents/[agentId]/conversations
 *
 * Creates a new conversation session for an AI agent. The conversation ID is
 * automatically generated using CUID2 for security and uniqueness. Messages
 * sent after creation will be associated with this conversation ID.
 *
 * @param agentId - The unique identifier of the AI agent (AI_CHAT page ID)
 * @param request.body - Optional JSON body with:
 *   - title: Optional custom title for the conversation (currently not persisted)
 *
 * @returns {object} Response object containing:
 *   - conversationId: Newly generated unique conversation identifier
 *   - title: The conversation title (custom or default)
 *   - createdAt: Timestamp of conversation creation
 *
 * @throws {403} If user doesn't have view permission for the agent
 * @throws {404} If agent doesn't exist or isn't AI_CHAT type
 * @throws {500} If conversation creation fails
 *
 * @example
 * POST /api/ai/page-agents/abc123/conversations
 * Body: { "title": "My Custom Conversation" }
 * Response: {
 *   conversationId: "conv_def456",
 *   title: "My Custom Conversation",
 *   createdAt: "2025-10-26T12:00:00Z"
 * }
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ agentId: string }> }
) {
  try {
    const auth = await authenticateHybridRequest(request);
    if (isAuthError(auth)) return auth.error;

    const { agentId } = await context.params;

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
        { error: 'Insufficient permissions to create conversations for this agent' },
        { status: 403 }
      );
    }

    // Parse request body (optional custom title)
    const body = await request.json().catch(() => ({}));
    const customTitle = body.title;

    // Generate new conversation ID using createId
    const { createId } = await import('@paralleldrive/cuid2');
    const conversationId = createId();

    return NextResponse.json({
      conversationId,
      title: customTitle || 'New conversation',
      createdAt: new Date(),
    });

  } catch (error) {
    loggers.ai.error('Error creating conversation:', error as Error);
    return NextResponse.json(
      { error: 'Failed to create conversation' },
      { status: 500 }
    );
  }
}
