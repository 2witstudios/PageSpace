import { NextResponse } from 'next/server';
import { createId, isCuid } from '@paralleldrive/cuid2';
import { checkSessionAccess, createConversationInSession } from '@/lib/agent-sessions/agent-sessions-runtime';
import {
  AgentNotInSessionDriveError,
  ConversationUnavailableError,
  SessionFullError,
} from '@/lib/agent-sessions/create-conversation-in-session';
import { sessionConversationLimitExceeded } from '@/lib/agent-sessions/quota-response';
import { sessionNotFoundOrDenied } from '@/lib/agent-sessions/session-unavailable-response';
import { authenticateRequestWithOptions, isAuthError, checkMCPPageScope, canPrincipalViewPage } from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import {
  conversationRepository,
  extractPreviewText,
  generateTitle,
} from '@/lib/repositories/conversation-repository';
import { parseBoundedIntParam } from '@/lib/utils/query-params';

// Auth options: GET is read-only, POST creates new conversations
const AUTH_OPTIONS_READ = { allow: ['session', 'mcp'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session', 'mcp'] as const, requireCSRF: true };

/**
 * GET /api/ai/page-agents/[agentId]/conversations
 *
 * Lists all conversations for a specific AI agent with pagination support.
 * Returns conversations in reverse chronological order (most recent first).
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ agentId: string }> }
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) {
      auditRequest(request, { eventType: 'authz.access.denied', resourceType: 'page_agent_conversation', resourceId: 'list', details: { reason: 'auth_failed', method: 'GET', authFailureReason: auth.authFailureReason }, riskScore: 0.5 });
      return auth.error;
    }

    const { agentId } = await context.params;

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
    if (scopeError) {
      auditRequest(request, { eventType: 'authz.access.denied', userId: auth.userId, resourceType: 'page_agent_conversation', resourceId: agentId, details: { reason: 'mcp_page_scope_denied', method: 'GET' }, riskScore: 0.5 });
      return scopeError;
    }

    // Check permissions
    const canView = await canPrincipalViewPage(auth, agentId);
    if (!canView) {
      auditRequest(request, { eventType: 'authz.access.denied', userId: auth.userId, resourceType: 'page_agent_conversation', resourceId: agentId, details: { reason: 'no_view_permission', method: 'GET' }, riskScore: 0.5 });
      return NextResponse.json(
        { error: 'Insufficient permissions to view this agent' },
        { status: 403 }
      );
    }

    // Get URL params for pagination
    const { searchParams } = new URL(request.url);
    const page = parseBoundedIntParam(searchParams.get('page'), {
      defaultValue: 0,
      min: 0,
      max: 10000,
    });
    const pageSize = parseBoundedIntParam(searchParams.get('pageSize'), {
      defaultValue: 50,
      min: 1,
      max: 200,
    });
    const offset = page * pageSize;

    // Get conversations with stats — scoped to this user (private) + shared ones
    const conversationsData = await conversationRepository.listConversations(
      agentId,
      pageSize,
      offset,
      auth.userId
    );

    // Format conversations for response
    const conversations = conversationsData.map(conv => {
      const preview = extractPreviewText(conv.firstUserMessage);
      const title = generateTitle(preview);
      const isShared = conv.isShared ?? false;
      const isOwner = conv.conversationUserId === auth.userId;

      return {
        id: conv.conversationId,
        title,
        preview,
        createdAt: conv.firstMessageTime,
        updatedAt: conv.lastMessageTime,
        messageCount: Number(conv.messageCount),
        isShared,
        isOwner,
        // The workspace the thread was born into (null = plain page chat) —
        // what lets the page's Chat tab render the pane grid for it.
        sessionId: conv.sessionId ?? null,
        lastMessage: {
          role: conv.lastMessageRole,
          timestamp: conv.lastMessageTime,
        },
      };
    });

    // Get total count for pagination — same privacy filter
    const totalCount = await conversationRepository.countConversations(agentId, auth.userId);

    auditRequest(request, { eventType: 'data.read', userId: auth.userId, resourceType: 'page_agent_conversation', resourceId: agentId, details: {
      action: 'list_conversations',
    } });

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
 * automatically generated using CUID2 for security and uniqueness.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ agentId: string }> }
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) {
      auditRequest(request, { eventType: 'authz.access.denied', resourceType: 'page_agent_conversation', resourceId: 'create', details: { reason: 'auth_failed', method: 'POST', authFailureReason: auth.authFailureReason }, riskScore: 0.5 });
      return auth.error;
    }

    const { agentId } = await context.params;

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
    if (scopeError) {
      auditRequest(request, { eventType: 'authz.access.denied', userId: auth.userId, resourceType: 'page_agent_conversation', resourceId: agentId, details: { reason: 'mcp_page_scope_denied', method: 'POST' }, riskScore: 0.5 });
      return scopeError;
    }

    // Check permissions
    const canView = await canPrincipalViewPage(auth, agentId);
    if (!canView) {
      auditRequest(request, { eventType: 'authz.access.denied', userId: auth.userId, resourceType: 'page_agent_conversation', resourceId: agentId, details: { reason: 'no_view_permission', method: 'POST' }, riskScore: 0.5 });
      return NextResponse.json(
        { error: 'Insufficient permissions to create conversations for this agent' },
        { status: 403 }
      );
    }

    // Parse request body (optional custom title, optional client-generated id)
    const body = await request.json().catch(() => ({}));
    const customTitle = body.title;

    // Prefer a client-generated id (cuid2) so the caller knows its conversation
    // id synchronously, before this request resolves. Fall back to generating
    // one server-side for callers that don't supply one, or that supply a
    // malformed value — only genuine CUID2 strings are trusted as a row id.
    const conversationId: string =
      typeof body.conversationId === 'string' && isCuid(body.conversationId)
        ? body.conversationId
        : createId();

    // Optional session binding — the thread is BORN into its working context
    // (contract invariant 1: set once at creation, permanent; a session hosts
    // many conversations and owns the one sandbox they share). Gated on the
    // session access check so a caller cannot bind a thread into a workspace
    // they cannot reach.
    const sessionId: string | null =
      typeof body.sessionId === 'string' && body.sessionId.length > 0 ? body.sessionId : null;
    if (sessionId !== null) {
      const sessionAccess = await checkSessionAccess(auth.userId, sessionId);
      if (!sessionAccess.allowed) {
        // Not found and denied answer THE SAME 404 — the [sessionId] family's
        // policy (review #2261/5), applied here too since this route gates on
        // the identical checkSessionAccess call: a 403-vs-404 split would let
        // a caller learn whether a session id is real even when they can
        // never touch it.
        return sessionNotFoundOrDenied(request, auth.userId, sessionId, sessionAccess.reason, 'page-agents/conversations');
      }
    }

    // Eagerly persist ownership so privacy filtering works immediately.
    // isShared defaults to false — conversation is private to this user.
    if (sessionId !== null) {
      try {
        await createConversationInSession({ conversationId, userId: auth.userId, agentPageId: agentId, sessionId });
      } catch (error) {
        if (error instanceof SessionFullError) {
          return sessionConversationLimitExceeded(request, auth.userId, sessionId, 'page-agents/conversations');
        }
        if (error instanceof ConversationUnavailableError) {
          // The id cannot be claimed WITH this binding (someone else's row, a
          // legacy conflict, or a different session's thread) — a state
          // conflict, not a service failure, and one answer for every cause.
          auditRequest(request, { eventType: 'authz.access.denied', userId: auth.userId, resourceType: 'page_agent_conversation', resourceId: conversationId, details: { reason: 'conversation_unavailable', method: 'POST', agentId, sessionId }, riskScore: 0.5 });
          return NextResponse.json({ error: 'That conversation id is not available' }, { status: 409 });
        }
        if (error instanceof AgentNotInSessionDriveError) {
          // A caller mistake (this agent belongs to a different drive than
          // the session), not a service failure (review #2261/6) — was
          // falling through to the outer catch's generic 500.
          return NextResponse.json({ error: error.message }, { status: 400 });
        }
        throw error;
      }
    } else {
      await conversationRepository.createConversation(conversationId, auth.userId, agentId);
    }

    const response = {
      conversationId,
      title: customTitle || 'New conversation',
      createdAt: new Date(),
    };

    // Private conversations are not broadcast — only the creator sees them.

    auditRequest(request, { eventType: 'data.write', userId: auth.userId, resourceType: 'page_agent_conversation', resourceId: conversationId, details: {
      action: 'create_conversation',
      agentId,
    } });

    return NextResponse.json(response);

  } catch (error) {
    loggers.ai.error('Error creating conversation:', error as Error);
    return NextResponse.json(
      { error: 'Failed to create conversation' },
      { status: 500 }
    );
  }
}
