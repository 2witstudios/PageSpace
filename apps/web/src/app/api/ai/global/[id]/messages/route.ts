import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db } from '@pagespace/db/db'
import { eq, and, desc, gt, lt, ne } from '@pagespace/db/operators'
import { conversations, messages } from '@pagespace/db/schema/conversations';
import { convertGlobalAssistantMessageToUIMessage } from '@/lib/ai/core/message-utils';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { parseBoundedIntParam } from '@/lib/utils/query-params';
import { handleChatTurn } from '@/lib/ai/chat-pipeline/handle-chat-turn';

// Allow streaming responses up to 5 minutes
export const maxDuration = 300;

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };

/**
 * GET - Get all messages for a conversation
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) {
      auditRequest(request, { eventType: 'authz.access.denied', resourceType: 'global_chat_message', resourceId: 'list', details: { reason: 'auth_failed', method: 'GET', authFailureReason: auth.authFailureReason }, riskScore: 0.5 });
      return auth.error;
    }
    const userId = auth.userId;

    const { id } = await context.params;

    // Verify user owns the conversation
    const [conversation] = await db
      .select()
      .from(conversations)
      .where(and(
        eq(conversations.id, id),
        eq(conversations.userId, userId),
        eq(conversations.isActive, true)
      ));

    if (!conversation) {
      // Conversation not yet persisted (lazy creation) — return empty rather than 404
      // so browsers don't log a network error for brand-new conversations.
      // Use the same { messages, pagination } shape as the persisted-conversation path.
      return NextResponse.json({
        messages: [],
        pagination: { hasMore: false, nextCursor: null, prevCursor: null, limit: 50, direction: 'before' },
        // No row means no rev to hold a watermark against — the subscriber treats
        // `null` as "no proven baseline" and refetches on any versioned event.
        rev: null,
      });
    }

    // Parse pagination parameters
    const { searchParams } = new URL(request.url);
    const limit = parseBoundedIntParam(searchParams.get('limit'), {
      defaultValue: 50,
      min: 1,
      max: 200,
    });
    const cursor = searchParams.get('cursor'); // Message ID for cursor-based pagination
    const direction = searchParams.get('direction') || 'before'; // 'before' or 'after'
    // Stale-tab rollout protection: clients deployed before this PR never send this param, so
    // they never see 'streaming' placeholder rows — only updated clients that know how to
    // dedup them against a live stream bubble opt in. See Server Stream Durability epic PR 2.
    const includeStreaming = searchParams.get('includeStreaming') === '1';

    // Build query conditions
    const conditions = [
      eq(messages.conversationId, id),
      eq(messages.isActive, true),
      ...(includeStreaming ? [] : [ne(messages.status, 'streaming')])
    ];

    // Add cursor condition if provided
    if (cursor) {
      // First, get the timestamp of the cursor message
      const [cursorMessage] = await db
        .select({ createdAt: messages.createdAt })
        .from(messages)
        .where(eq(messages.id, cursor))
        .limit(1);

      if (cursorMessage) {
        if (direction === 'before') {
          // Get messages created before the cursor (older messages)
          conditions.push(lt(messages.createdAt, cursorMessage.createdAt));
        } else {
          // Get messages created after the cursor (newer messages)
          conditions.push(gt(messages.createdAt, cursorMessage.createdAt));
        }
      }
    }

    // Get messages with pagination
    // Order by createdAt DESC to get newest first, then reverse for chronological display
    const conversationMessages = await db
      .select()
      .from(messages)
      .where(and(...conditions))
      .orderBy(desc(messages.createdAt))
      .limit(limit + 1); // Get one extra to check if there are more

    // Check if there are more messages
    const hasMore = conversationMessages.length > limit;
    const messagesToReturn = hasMore ? conversationMessages.slice(0, limit) : conversationMessages;

    // Reverse messages to show in chronological order (oldest first)
    const orderedMessages = messagesToReturn.reverse();

    // Convert to UIMessage format with proper tool call reconstruction
    const uiMessages = await Promise.all(orderedMessages.map(msg =>
      convertGlobalAssistantMessageToUIMessage({
        id: msg.id,
        conversationId: msg.conversationId,
        userId: msg.userId,
        role: msg.role,
        content: msg.content,
        toolCalls: msg.toolCalls,
        toolResults: msg.toolResults,
        createdAt: msg.createdAt,
        isActive: msg.isActive,
        editedAt: msg.editedAt,
        status: msg.status,
      })
    ));

    // Determine cursors for pagination
    const nextCursor = hasMore && orderedMessages.length > 0
      ? orderedMessages[0].id // First message (oldest) for loading even older messages
      : null;

    const prevCursor = orderedMessages.length > 0
      ? orderedMessages[orderedMessages.length - 1].id // Last message (newest) for loading newer messages
      : null;

    auditRequest(request, { eventType: 'data.read', userId, resourceType: 'global_chat_message', resourceId: id, details: {
      action: 'list_messages',
    } });

    return NextResponse.json({
      messages: uiMessages,
      pagination: {
        hasMore,
        nextCursor,
        prevCursor,
        limit,
        direction
      },
      // The rev watermark this snapshot was read at (Agent-Session SSoT epic,
      // Phase 2). The client holds it per cache entry and proves currency
      // against every `conversation:*` event — see
      // `apps/web/src/lib/realtime/conversation-apply.ts`. Read from the same
      // row the ownership check above already fetched, so it costs no query.
      rev: conversation.rev,
    });
  } catch (error) {
    loggers.api.error('Error fetching messages:', error as Error);
    return NextResponse.json({
      error: 'Failed to fetch messages'
    }, { status: 500 });
  }
}

/**
 * POST - one global-assistant chat turn.
 *
 * A thin surface over the SHARED chat entry (epic "Agent-Session Single Source
 * of Truth", Phase 5): `POST /api/ai/chat` calls the very same
 * `handleChatTurn`, which picks the strategy from the CONVERSATION rather than
 * from the URL. This URL's wire contract is unchanged - same auth (session
 * only), same body, same responses, same stream - so every deployed client,
 * the desktop app, mobile, the CLI and any running agent keep working. What is
 * gone is the second implementation behind it.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return handleChatTurn(request, { surface: 'global-messages', urlConversationId: id });
}
