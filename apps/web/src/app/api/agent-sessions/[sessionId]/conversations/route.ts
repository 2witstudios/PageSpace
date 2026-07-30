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
} from '@/lib/agent-sessions/agent-sessions-runtime';
import { conversationRepository } from '@/lib/repositories/conversation-repository';

const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

type RouteContext = { params: Promise<{ sessionId: string }> };

function denied(request: Request, userId: string, sessionId: string, reason: string): NextResponse {
  auditRequest(request, {
    eventType: 'authz.access.denied',
    userId,
    resourceType: 'agent_session',
    resourceId: sessionId,
    details: { reason, route: 'agent-sessions/[sessionId]/conversations' },
    riskScore: 0.5,
  });
  return NextResponse.json({ error: 'You do not have access to this session' }, { status: 403 });
}

export async function POST(request: Request, context: RouteContext) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;
  const { sessionId } = await context.params;

  let body: { agentPageId?: unknown; conversationId?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    // An empty body is a valid assistant-thread request (agentPageId null).
  }
  const agentPageId =
    typeof body.agentPageId === 'string' && body.agentPageId.length > 0 ? body.agentPageId : null;

  // The session must already EXIST — a conversation joins a workspace, it
  // never mints one (spawning a session is the collection route's act).
  const access = await checkSessionAccess(auth.userId, sessionId);
  if (!access.allowed) {
    if (access.reason === 'session_not_found') {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }
    return denied(request, auth.userId, sessionId, access.reason);
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
        details: { reason: 'no_view_permission', route: 'agent-sessions/[sessionId]/conversations' },
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
      sessionId,
    });
  } catch (error) {
    loggers.api.error(
      'Session conversation create failed',
      error instanceof Error ? error : undefined,
      { sessionId, agentPageId },
    );
    return NextResponse.json({ error: 'Could not start a conversation' }, { status: 502 });
  }

  auditRequest(request, {
    eventType: 'data.write',
    userId: auth.userId,
    resourceType: 'agent_session',
    resourceId: sessionId,
    details: { op: 'create_conversation', conversationId, agentPageId },
  });

  return NextResponse.json({ conversationId }, { status: 201 });
}
