/**
 * Reopen ONE conversation back INTO its session's listing — the undo of the
 * sibling `[conversationId]` route's DELETE.
 *
 * POST → 200 { ok: true } — the console's "History" affordance: a closed
 * listing is invisible to `GET /api/agent-sessions` (see
 * `listSessionConversationsBulk`'s doc) but its transcript is untouched, so
 * this is how a user gets back to a conversation they closed a pane on. It
 * never touches history — same as the close route, this stamps/clears
 * `conversations.closedInSessionAt` only.
 *
 * Subject to the same `MAX_SESSION_CONVERSATIONS` ceiling the create route
 * enforces (`session_full` → the shared 429), because reopening occupies an
 * open-listing slot exactly like minting a new conversation does.
 *
 * Gated by the same ordinary session access check the close route uses —
 * this is a routine write, not a capability-gated act.
 */

import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { checkSessionAccess, reopenConversationInSession } from '@/lib/agent-sessions/agent-sessions-runtime';
import { sessionNotFoundOrDenied } from '@/lib/agent-sessions/session-unavailable-response';
import { sessionConversationLimitExceeded } from '@/lib/agent-sessions/quota-response';

const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

const ROUTE = 'agent-sessions/[sessionId]/conversations/[conversationId]/reopen';

type RouteContext = { params: Promise<{ sessionId: string; conversationId: string }> };

export async function POST(request: Request, context: RouteContext) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;
  const { sessionId, conversationId } = await context.params;

  const access = await checkSessionAccess(auth.userId, sessionId);
  if (!access.allowed) {
    return sessionNotFoundOrDenied(request, auth.userId, sessionId, access.reason, ROUTE);
  }

  let outcome: Awaited<ReturnType<typeof reopenConversationInSession>>;
  try {
    outcome = await reopenConversationInSession({ conversationId, sessionId });
  } catch (error) {
    loggers.api.error(
      'Session conversation reopen failed',
      error instanceof Error ? error : undefined,
      { sessionId, conversationId },
    );
    return NextResponse.json({ error: 'Could not reopen this conversation' }, { status: 500 });
  }

  if (outcome === 'not_in_session' || outcome === 'history_deleted') {
    // Same "nothing here" shape whether the id never existed, names a
    // conversation some OTHER session owns, or was history-deleted — an
    // id-guessing caller learns nothing either way.
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
  }

  if (outcome === 'session_full') {
    return sessionConversationLimitExceeded(request, auth.userId, sessionId, ROUTE);
  }

  if (outcome === 'reopened') {
    auditRequest(request, {
      eventType: 'data.write',
      userId: auth.userId,
      resourceType: 'agent_session',
      resourceId: sessionId,
      details: { op: 'reopen_conversation', conversationId },
    });
  }

  // `alreadyOpen` (outcome === 'already_open'): this call did NOT transition
  // the listing — it was already open (e.g. a different pane, tab, or an
  // agent switch that left it open but unshown). The caller needs this to
  // know whether it's safe to roll the listing back out if THIS request
  // turns out to be superseded — doing so unconditionally would close a
  // listing the request never actually opened, possibly still in use
  // elsewhere (review finding — chatgpt-codex-connector on PR #2299,
  // round 15).
  return NextResponse.json({ ok: true, alreadyOpen: outcome === 'already_open' });
}
