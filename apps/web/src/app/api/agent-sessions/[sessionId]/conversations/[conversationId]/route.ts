/**
 * Close ONE conversation OUT of its session's listing.
 *
 * DELETE → 200 { ok: true } — the session's grid act (a pane-close-lifecycle
 * audit follow-up): closing the last PANE bound to a conversation closes THAT
 * listing, uniformly for page-agent and assistant threads alike (there is no
 * page to hang a page-agents-scoped delete on for an assistant thread, same
 * reason the sibling POST in this family exists). This is NOT the
 * history-deleting `ai/page-agents/[agentId]/conversations/[conversationId]`
 * DELETE — closing a listing never touches a thread's history (see
 * `conversations.closedInSessionAt`'s doc).
 *
 * A session is never empty (contract invariant 3): closing the session's LAST
 * open listing is refused with 409 — the client's remedy is to end the
 * session instead, a different act on a different route.
 *
 * Gated by the ordinary session access check (identity + drive membership),
 * NOT the end-access check — closing one listing is a routine write, not the
 * capability-gated act of tearing down the session's sandbox. Not
 * found/denied answer the family's uniform 404 (review #2261/5).
 */

import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { checkSessionAccess, closeConversationInSession } from '@/lib/agent-sessions/agent-sessions-runtime';
import { sessionNotFoundOrDenied } from '@/lib/agent-sessions/session-unavailable-response';

const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

const ROUTE = 'agent-sessions/[sessionId]/conversations/[conversationId]';

type RouteContext = { params: Promise<{ sessionId: string; conversationId: string }> };

export async function DELETE(request: Request, context: RouteContext) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;
  const { sessionId, conversationId } = await context.params;

  const access = await checkSessionAccess(auth.userId, sessionId);
  if (!access.allowed) {
    return sessionNotFoundOrDenied(request, auth.userId, sessionId, access.reason, ROUTE);
  }

  let outcome: Awaited<ReturnType<typeof closeConversationInSession>>;
  try {
    outcome = await closeConversationInSession({ conversationId, sessionId });
  } catch (error) {
    loggers.api.error(
      'Session conversation close failed',
      error instanceof Error ? error : undefined,
      { sessionId, conversationId },
    );
    return NextResponse.json({ error: 'Could not close this conversation' }, { status: 502 });
  }

  if (outcome === 'not_in_session') {
    // Same "nothing here" shape whether the id never existed or names a
    // conversation some OTHER session owns — an id-guessing caller learns
    // nothing either way.
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
  }

  if (outcome === 'last_conversation') {
    // A never-empty-session refusal, not an authorization failure (same
    // reasoning as `quota-response.ts`'s `security.rate.limited` — the caller
    // has every right to this session and has simply run out of something to
    // close; the remedy is ending the session, not being granted access).
    auditRequest(request, {
      eventType: 'security.rate.limited',
      userId: auth.userId,
      resourceType: 'agent_session',
      resourceId: sessionId,
      details: { reason: 'last_conversation', conversationId, route: ROUTE },
      riskScore: 0,
    });
    return NextResponse.json(
      { error: 'This is the only open conversation in the session — end the session instead.', reason: 'last_conversation' },
      { status: 409 },
    );
  }

  if (outcome === 'closed') {
    auditRequest(request, {
      eventType: 'data.write',
      userId: auth.userId,
      resourceType: 'agent_session',
      resourceId: sessionId,
      details: { op: 'close_conversation', conversationId },
    });
  }

  return NextResponse.json({ ok: true });
}
