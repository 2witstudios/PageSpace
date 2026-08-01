/**
 * Claim ONE never-session-bound conversation INTO this session's listing —
 * the "open into a session" affordance for a conversation an owner opened
 * outside the Agents console (a page-agent or global-assistant chat that
 * never had a sandbox), and for a pane's own History tab picking a past
 * conversation that turns out to be unbound rather than closed-in-THIS-
 * session (the reopen route's job).
 *
 * POST → 200 { ok: true, alreadyInSession: boolean } — wraps
 * `claimConversationInSession` (`claim-conversation-in-session.ts`), the ONE
 * place `conversations.sessionId` is ever written.
 *
 * `checkSessionAccess` below authorizes the SESSION — drive-membership-wide,
 * so any drive member reaches another member's session. That is NOT
 * ownership of the CONVERSATION: the claim primitive's own guarded UPDATE
 * carries `userId = :caller` in its WHERE, which is what stops a drive
 * co-member from claiming a co-member's own sessionless thread into their
 * session. Neither check substitutes for the other.
 */

import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { checkSessionAccess, claimConversationInSession } from '@/lib/agent-sessions/agent-sessions-runtime';
import { sessionNotFoundOrDenied } from '@/lib/agent-sessions/session-unavailable-response';
import { sessionConversationLimitExceeded } from '@/lib/agent-sessions/quota-response';

const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

const ROUTE = 'agent-sessions/[sessionId]/conversations/[conversationId]/claim';

type RouteContext = { params: Promise<{ sessionId: string; conversationId: string }> };

export async function POST(request: Request, context: RouteContext) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;
  const { sessionId, conversationId } = await context.params;

  const access = await checkSessionAccess(auth.userId, sessionId);
  if (!access.allowed) {
    return sessionNotFoundOrDenied(request, auth.userId, sessionId, access.reason, ROUTE);
  }

  let outcome: Awaited<ReturnType<typeof claimConversationInSession>>;
  try {
    outcome = await claimConversationInSession({ conversationId, userId: auth.userId, sessionId });
  } catch (error) {
    loggers.api.error(
      'Session conversation claim failed',
      error instanceof Error ? error : undefined,
      { sessionId, conversationId },
    );
    return NextResponse.json({ error: 'Could not move this conversation into the session' }, { status: 500 });
  }

  if (outcome === 'not_found') {
    // Same "nothing here" shape whether the id never existed, belongs to
    // someone else, was history-deleted, or is already bound to some OTHER
    // session — an id-guessing caller learns nothing either way.
    return NextResponse.json({ error: 'That conversation is not available' }, { status: 404 });
  }

  if (outcome === 'cross_drive_denied') {
    return NextResponse.json(
      { error: 'That conversation belongs to a different drive than this session' },
      { status: 400 },
    );
  }

  if (outcome === 'session_ended') {
    return NextResponse.json({ error: 'This session has ended' }, { status: 409 });
  }

  if (outcome === 'session_full') {
    return sessionConversationLimitExceeded(request, auth.userId, sessionId, ROUTE);
  }

  if (outcome === 'claimed') {
    auditRequest(request, {
      eventType: 'data.write',
      userId: auth.userId,
      resourceType: 'agent_session',
      resourceId: sessionId,
      details: { op: 'claim_conversation', conversationId },
    });
  }

  // `alreadyInSession` (outcome === 'already_in_session'): this call did NOT
  // transition anything — same reasoning as the reopen route's
  // `alreadyOpen`, so a caller superseded mid-flight knows whether it's
  // safe to roll the listing back out.
  return NextResponse.json({ ok: true, alreadyInSession: outcome === 'already_in_session' });
}
