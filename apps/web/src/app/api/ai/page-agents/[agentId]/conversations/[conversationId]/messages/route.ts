import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError, checkMCPPageScope, canPrincipalViewPage } from '@/lib/auth';
import { db } from '@pagespace/db/db'
import { eq, and, ne, desc, sql } from '@pagespace/db/operators'
import { conversations, messages } from '@pagespace/db/schema/conversations';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { convertDbMessageToUIMessage } from '@/lib/ai/core/message-utils';
import { parseBoundedIntParam } from '@/lib/utils/query-params';
import { conversationRepository } from '@/lib/repositories/conversation-repository';
import { unifiedPageScope } from '@/lib/repositories/unified-message-scope';

// Auth options: GET is read-only operation
const AUTH_OPTIONS_READ = { allow: ['session', 'mcp'] as const, requireCSRF: false };

/**
 * GET /api/ai/page-agents/[agentId]/conversations/[conversationId]/messages
 *
 * Retrieves messages for a specific conversation session with optional cursor-based pagination.
 * Messages are returned in UIMessage format compatible with the Vercel AI SDK,
 * including tool calls and tool results if present.
 *
 * @param agentId - The conversation-hosting AI_CHAT agent page id
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
    if (isAuthError(auth)) {
      auditRequest(request, { eventType: 'authz.access.denied', resourceType: 'page_agent_message', resourceId: 'list', details: { reason: 'auth_failed', method: 'GET', authFailureReason: auth.authFailureReason }, riskScore: 0.5 });
      return auth.error;
    }

    const { agentId, conversationId } = await context.params;

    // Verify the conversation-hosting agent page exists. Goes through the
    // repository like its two sibling routes rather than repeating the query:
    // WHICH page types may host a conversation is one decision, and an inline
    // copy is how the last change to it (dropping MACHINE) reached two of the
    // three routes and not the third.
    const agent = await conversationRepository.getAiAgent(agentId);

    if (!agent) {
      return NextResponse.json(
        { error: 'AI agent not found' },
        { status: 404 }
      );
    }

    // Check MCP page scope
    const scopeError = await checkMCPPageScope(auth, agentId);
    if (scopeError) {
      auditRequest(request, { eventType: 'authz.access.denied', userId: auth.userId, resourceType: 'page_agent_message', resourceId: conversationId, details: { reason: 'mcp_page_scope_denied', agentId, method: 'GET' }, riskScore: 0.5 });
      return scopeError;
    }

    // Check permissions
    const canView = await canPrincipalViewPage(auth, agentId);
    if (!canView) {
      auditRequest(request, { eventType: 'authz.access.denied', userId: auth.userId, resourceType: 'page_agent_message', resourceId: conversationId, details: { reason: 'no_view_permission', agentId, method: 'GET' }, riskScore: 0.5 });
      return NextResponse.json(
        { error: 'Insufficient permissions to view this agent\'s conversations' },
        { status: 403 }
      );
    }

    // Conversation access gate: private conversations are only visible to their owner
    const conversationRow = await conversationRepository.getConversation(conversationId);
    if (conversationRow && conversationRow.userId !== auth.userId && !conversationRow.isShared) {
      auditRequest(request, { eventType: 'authz.access.denied', userId: auth.userId, resourceType: 'page_agent_message', resourceId: conversationId, details: { reason: 'private_conversation', agentId, method: 'GET' }, riskScore: 0.5 });
      return NextResponse.json(
        { error: 'Insufficient permissions to access this conversation' },
        { status: 403 }
      );
    }

    // Parse pagination parameters with validation
    const { searchParams } = new URL(request.url);
    const limit = parseBoundedIntParam(searchParams.get('limit'), {
      defaultValue: 50,
      min: 1,
      max: 200,
    });
    const cursor = searchParams.get('cursor'); // Message ID for cursor-based pagination
    const directionParam = searchParams.get('direction');
    const direction = (directionParam === 'before' || directionParam === 'after')
      ? directionParam
      : 'before';
    // Stale-tab rollout protection: clients deployed before this PR never send this param, so
    // they never see 'streaming' placeholder rows — only updated clients that know how to
    // dedup them against a live stream bubble opt in. See Server Stream Durability epic PR 2.
    const includeStreaming = searchParams.get('includeStreaming') === '1';

    // Build query conditions.
    //
    // Reads the UNIFIED `messages` table since the message-table merge (epic
    // "Agent-Session Single Source of Truth", Phase 4 / D6). The page
    // predicate is `unifiedPageScope` — the join through `conversations`,
    // which is what `chat_messages.pageId` became. `chat_messages` is still
    // dual-written, so a revert of that cutover is safe.
    const conditions = [
      unifiedPageScope(agentId),
      eq(messages.conversationId, conversationId),
      eq(messages.isActive, true),
      ...(includeStreaming ? [] : [ne(messages.status, 'streaming')])
    ];

    // Add cursor condition if provided - use compound cursor (createdAt + id) for stable ordering
    if (cursor) {
      // First, get the timestamp and id of the cursor message
      const [cursorMessage] = await db
        .select({ createdAt: messages.createdAt, id: messages.id })
        .from(messages)
        .where(eq(messages.id, cursor))
        .limit(1);

      if (cursorMessage && cursorMessage.createdAt) {
        if (direction === 'before') {
          // Get messages created before the cursor (older messages)
          // Use compound condition: either earlier timestamp, or same timestamp but smaller id
          conditions.push(
            sql`(${messages.createdAt} < ${cursorMessage.createdAt} OR (${messages.createdAt} = ${cursorMessage.createdAt} AND ${messages.id} < ${cursorMessage.id}))`
          );
        } else {
          // Get messages created after the cursor (newer messages)
          // Use compound condition: either later timestamp, or same timestamp but larger id
          conditions.push(
            sql`(${messages.createdAt} > ${cursorMessage.createdAt} OR (${messages.createdAt} = ${cursorMessage.createdAt} AND ${messages.id} > ${cursorMessage.id}))`
          );
        }
      }
    }

    // Get messages with pagination
    // Order by (createdAt DESC, id DESC) for stable pagination, then reverse for chronological display
    const dbMessages = await db
      .select({
        id: messages.id,
        pageId: messages.pageId,
        userId: messages.userId,
        role: messages.role,
        content: messages.content,
        toolCalls: messages.toolCalls,
        toolResults: messages.toolResults,
        createdAt: messages.createdAt,
        isActive: messages.isActive,
        editedAt: messages.editedAt,
        messageType: messages.messageType,
        status: messages.status,
      })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(and(...conditions))
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(limit + 1); // Get one extra to check if there are more

    // Check if there are more messages
    const hasMore = dbMessages.length > limit;
    const messagesToReturn = hasMore ? dbMessages.slice(0, limit) : dbMessages;

    // Reverse messages to show in chronological order (oldest first)
    const orderedMessages = messagesToReturn.reverse();

    // Convert to UIMessage format
    const uiMessages = await Promise.all(orderedMessages.map(convertDbMessageToUIMessage));

    // Determine cursors for pagination
    const nextCursor = hasMore && orderedMessages.length > 0
      ? orderedMessages[0].id // First message (oldest) for loading even older messages
      : null;

    const prevCursor = orderedMessages.length > 0
      ? orderedMessages[orderedMessages.length - 1].id // Last message (newest) for loading newer messages
      : null;

    auditRequest(request, { eventType: 'data.read', userId: auth.userId, resourceType: 'page_agent_message', resourceId: conversationId, details: {
      action: 'list_messages',
      agentId,
    } });

    return NextResponse.json({
      messages: uiMessages,
      conversationId,
      messageCount: uiMessages.length,
      pagination: {
        hasMore,
        nextCursor,
        prevCursor,
        limit,
        direction
      },
      // The rev watermark this snapshot was read at (Agent-Session SSoT epic,
      // Phase 2) — the client proves currency against every `conversation:*`
      // event with it (`apps/web/src/lib/realtime/conversation-apply.ts`).
      // `null` for a legacy page conversation with no `conversations` row: no
      // row, no rev, so the subscriber has no baseline and refetches on doubt.
      // Read from the row the access gate above already fetched.
      rev: conversationRow?.rev ?? null,
    });

  } catch (error) {
    loggers.ai.error('Error loading conversation messages:', error as Error);
    return NextResponse.json(
      { error: 'Failed to load conversation messages' },
      { status: 500 }
    );
  }
}
