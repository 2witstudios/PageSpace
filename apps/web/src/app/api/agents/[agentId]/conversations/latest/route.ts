import { NextResponse } from 'next/server';
import { authenticateHybridRequest, isAuthError } from '@/lib/auth';
import { db, pages, eq, and, sql } from '@pagespace/db';
import { canUserViewPage } from '@pagespace/lib/server';
import { loggers } from '@pagespace/lib/server';
import { createId } from '@paralleldrive/cuid2';

/**
 * GET /api/agents/[agentId]/conversations/latest
 *
 * Gets the most recent conversation for an AI agent, or creates a new one if none exists.
 * This is useful for resuming the last conversation when switching to an agent.
 *
 * @param agentId - The unique identifier of the AI agent (AI_CHAT page ID)
 *
 * @returns {object} Response object containing:
 *   - id: The conversation ID
 *   - title: The conversation title
 *   - createdAt: Timestamp of conversation creation
 *   - lastMessageAt: Timestamp of last message (null if new)
 *   - messageCount: Number of messages in the conversation
 *   - isNew: Boolean indicating if this is a newly created conversation
 *
 * @throws {403} If user doesn't have view permission for the agent
 * @throws {404} If agent doesn't exist or isn't AI_CHAT type
 * @throws {500} If database query fails
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ agentId: string }> }
) {
  try {
    const auth = await authenticateHybridRequest(request);
    if (isAuthError(auth)) return auth.error;

    const { agentId } = await context.params;

    // Validate agentId format (cuid2 is 24-25 lowercase alphanumeric)
    if (!agentId || !/^[a-z0-9]{20,30}$/.test(agentId)) {
      return NextResponse.json(
        { error: 'Invalid agent ID format' },
        { status: 400 }
      );
    }

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

    // Query the most recent conversation for this agent
    const latestConversationQuery = await db.execute<{
      conversationId: string;
      firstMessageTime: Date;
      lastMessageTime: Date;
      messageCount: number;
      firstUserMessage: string | null;
    }>(sql`
      WITH conversation_stats AS (
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
        SELECT DISTINCT ON ("conversationId")
          "conversationId",
          content as first_user_message
        FROM chat_messages
        WHERE "pageId" = ${agentId}
          AND "isActive" = true
          AND role = 'user'
        ORDER BY "conversationId", "createdAt" ASC
      )
      SELECT
        cs."conversationId" as "conversationId",
        cs.first_message_time as "firstMessageTime",
        cs.last_message_time as "lastMessageTime",
        cs.message_count as "messageCount",
        fum.first_user_message as "firstUserMessage"
      FROM conversation_stats cs
      LEFT JOIN first_user_messages fum ON cs."conversationId" = fum."conversationId"
      ORDER BY cs.last_message_time DESC
      LIMIT 1
    `);

    const latestConversation = latestConversationQuery.rows[0];

    if (latestConversation) {
      // Extract title from first user message
      let title = 'Conversation';
      try {
        if (latestConversation.firstUserMessage) {
          const parsed = JSON.parse(latestConversation.firstUserMessage);
          if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].text) {
            title = parsed[0].text.substring(0, 50);
          } else if (typeof parsed === 'object' && parsed.parts?.[0]?.text) {
            title = parsed.parts[0].text.substring(0, 50);
          }
        }
      } catch {
        if (latestConversation.firstUserMessage) {
          title = latestConversation.firstUserMessage.substring(0, 50);
        }
      }

      return NextResponse.json({
        id: latestConversation.conversationId,
        title,
        createdAt: latestConversation.firstMessageTime,
        lastMessageAt: latestConversation.lastMessageTime,
        messageCount: Number(latestConversation.messageCount),
        isNew: false,
      });
    }

    // No existing conversation - create a new one
    const newConversationId = createId();

    loggers.ai.info('Created new conversation for agent (no existing found)', {
      agentId,
      conversationId: newConversationId,
      userId: auth.userId,
    });

    return NextResponse.json({
      id: newConversationId,
      title: 'New conversation',
      createdAt: new Date(),
      lastMessageAt: null,
      messageCount: 0,
      isNew: true,
    });

  } catch (error) {
    loggers.ai.error('Error getting latest conversation:', error as Error);
    return NextResponse.json(
      { error: 'Failed to get latest conversation' },
      { status: 500 }
    );
  }
}
