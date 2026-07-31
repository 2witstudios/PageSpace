/**
 * A session's CLOSED conversations — the source list for the console's
 * "History" affordance (the reopen route's picker). A closed listing never
 * appears in `GET /api/agent-sessions` (see `listSessionConversationsBulk`'s
 * doc); this is the one read that surfaces them so a user can find and
 * reopen a conversation they closed a pane on.
 *
 * GET → 200 { conversations: SessionConversationEntry[] } — newest activity
 * first, capped at `MAX_SESSION_CONVERSATIONS` (see
 * `listClosedSessionConversations`'s doc for why: older history belongs to
 * the agent's own page History tab, not this session-scoped list).
 *
 * Gated by the same ordinary session access check every conversation route
 * in this family uses — a read, not a capability-gated act.
 */

import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { checkSessionAccess, listClosedSessionConversations } from '@/lib/agent-sessions/agent-sessions-runtime';
import { sessionNotFoundOrDenied } from '@/lib/agent-sessions/session-unavailable-response';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };

const ROUTE = 'agent-sessions/[sessionId]/conversations/closed';

type RouteContext = { params: Promise<{ sessionId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) return auth.error;
  const { sessionId } = await context.params;

  const access = await checkSessionAccess(auth.userId, sessionId);
  if (!access.allowed) {
    return sessionNotFoundOrDenied(request, auth.userId, sessionId, access.reason, ROUTE);
  }

  const conversations = await listClosedSessionConversations(sessionId);
  return NextResponse.json({ conversations });
}
