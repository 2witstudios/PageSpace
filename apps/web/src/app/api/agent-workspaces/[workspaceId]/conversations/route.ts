/**
 * A session's conversations — the threads living inside its ONE workspace.
 *
 * POST { agentPageId: string | null, conversationId? } → 201 { conversationId }
 *
 * The session-centric creation path: the thread is BORN into this session
 * (contract invariant 1 — bound at creation, permanent; moving a thread is a
 * fork, never a rebind). `agentPageId` names the thread's agent, and `null`
 * is the GLOBAL ASSISTANT — a `type: 'global'` conversation, the same rows the
 * assistant's own surfaces read. This route is how an assistant thread joins a
 * session at all: the assistant has no agent page for the page-agents
 * conversation route to hang permissions on.
 *
 * Access is layered exactly by what each id grants:
 * - the SESSION: the one shared access decision (drive membership +
 *   code-execution; owner-only for a global session) — 404 on no-such-session.
 * - the AGENT PAGE (when given): `canPrincipalViewPage`, the same check the
 *   page-agents conversation route makes — session access must never smuggle
 *   access to an agent page the requester cannot see.
 *
 * Like spawn, this is instant and free: no sandbox is provisioned here.
 */

import { NextResponse } from 'next/server';
import { createId, isCuid } from '@paralleldrive/cuid2';
import { authenticateRequestWithOptions, isAuthError, canPrincipalViewPage } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import {
  checkSessionAccess,
  createConversationInSession,
} from '@/lib/agent-workspaces/agent-sessions-runtime';
import {
  AgentNotInSessionDriveError,
  ConversationUnavailableError,
  SessionFullError,
} from '@/lib/agent-workspaces/create-conversation-in-session';
import { sessionConversationLimitExceeded } from '@/lib/agent-workspaces/quota-response';
import { sessionNotFoundOrDenied } from '@/lib/agent-workspaces/session-unavailable-response';
import { conversationRepository } from '@/lib/repositories/conversation-repository';

const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

const ROUTE = 'agent-workspaces/[workspaceId]/conversations';

type RouteContext = { params: Promise<{ workspaceId: string }> };

export async function POST(request: Request, context: RouteContext) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;
  const { workspaceId } = await context.params;

  let body: { agentPageId?: unknown; conversationId?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    // An empty body is a valid assistant-thread request (agentPageId null).
  }
  const agentPageId =
    typeof body.agentPageId === 'string' && body.agentPageId.length > 0 ? body.agentPageId : null;

  // The session must already EXIST — a conversation joins a workspace, it
  // never mints one (spawning a session is the collection route's act). Not
  // found and denied answer THE SAME 404 (family policy, review #2261/5).
  const access = await checkSessionAccess(auth.userId, workspaceId);
  if (!access.allowed) {
    return sessionNotFoundOrDenied(request, auth.userId, workspaceId, access.reason, ROUTE);
  }

  if (agentPageId !== null) {
    // Same two checks the page-agents conversation route makes: the page must
    // BE an agent, and the requester must be allowed to see it.
    const agent = await conversationRepository.getAiAgent(agentPageId);
    if (!agent) {
      return NextResponse.json({ error: 'AI agent not found' }, { status: 404 });
    }
    const canView = await canPrincipalViewPage(auth, agentPageId);
    if (!canView) {
      auditRequest(request, {
        eventType: 'authz.access.denied',
        userId: auth.userId,
        resourceType: 'page_agent_conversation',
        resourceId: agentPageId,
        details: { reason: 'no_view_permission', route: 'agent-workspaces/[workspaceId]/conversations' },
        riskScore: 0.5,
      });
      return NextResponse.json(
        { error: 'Insufficient permissions to create conversations for this agent' },
        { status: 403 },
      );
    }
  }

  // Prefer a client-generated id (cuid2) so the caller's pane knows its
  // conversation id synchronously; only genuine CUID2 strings are trusted.
  const conversationId: string =
    typeof body.conversationId === 'string' && isCuid(body.conversationId)
      ? body.conversationId
      : createId();

  try {
    await createConversationInSession({
      conversationId,
      userId: auth.userId,
      agentPageId,
      workspaceId,
    });
  } catch (error) {
    if (error instanceof SessionFullError) {
      return sessionConversationLimitExceeded(request, auth.userId, workspaceId, 'agent-workspaces/[workspaceId]/conversations');
    }
    if (error instanceof ConversationUnavailableError) {
      // The id names a conversation that cannot be claimed WITH this binding
      // (someone else's, a legacy conflict, or a different session's) — a
      // conflict with existing state, not a service failure. One message for
      // every cause: distinguishing them would tell an id-guessing caller
      // which one it hit.
      auditRequest(request, {
        eventType: 'authz.access.denied',
        userId: auth.userId,
        resourceType: 'agent_session',
        resourceId: workspaceId,
        details: { reason: 'conversation_unavailable', conversationId, route: ROUTE },
        riskScore: 0.5,
      });
      return NextResponse.json({ error: 'That conversation id is not available' }, { status: 409 });
    }
    if (error instanceof AgentNotInSessionDriveError) {
      // A caller mistake (an agent page from a DIFFERENT drive than this
      // session), not a service failure (review #2261/6) — was falling
      // through to the generic 502 below, which logged it as a server error
      // and told the caller to retry a request that can never succeed.
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    loggers.api.error(
      'Session conversation create failed',
      error instanceof Error ? error : undefined,
      { workspaceId, agentPageId },
    );
    return NextResponse.json({ error: 'Could not start a conversation' }, { status: 502 });
  }

  auditRequest(request, {
    eventType: 'data.write',
    userId: auth.userId,
    resourceType: 'agent_session',
    resourceId: workspaceId,
    details: { op: 'create_conversation', conversationId, agentPageId },
  });

  return NextResponse.json({ conversationId }, { status: 201 });
}
