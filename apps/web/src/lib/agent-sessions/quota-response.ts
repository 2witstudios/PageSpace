/**
 * The one plan-limit refusal, shared by every agent-session route.
 *
 * It was written out twice — verbatim, seventeen lines each, differing only in
 * the audit's `route` tag. That is the same duplication that let this PR ship a
 * tool client speaking a wire format its endpoint never used, so it gets the
 * same treatment: one definition, imported.
 *
 * A quota refusal is NOT an authorization failure. The caller has every right to
 * this session and has simply run out of allowance, so it is kept apart from
 * `denied()` on three axes:
 *
 *  - **429, not 403** — a rate/quantity limit, which clears by ending a sandbox
 *    rather than by being granted access to anything.
 *  - **`security.rate.limited`, not `authz.access.denied`** (and certainly not
 *    `data.read`) — a free-tier user clicking "new conversation" should not read
 *    as repeated access violations in the security audit, nor be filed into
 *    data-access forensics for a request that read nothing.
 *  - **Worded for a human, in the UI's vocabulary.** This string surfaces in the
 *    product (an "Add shell" failure renders `body.error`), and the project's
 *    rule is that "session" is the AI/tool/backend word while the UI says
 *    agents, conversations and sandboxes. It matches what the socket surface
 *    prints into the terminal pane for the identical refusal — one event should
 *    not read three different ways depending on which layer said no.
 */
import { NextResponse } from 'next/server';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

/** Human-facing copy for a plan-limit refusal. Kept beside the response so the two cannot drift. */
export const SESSION_QUOTA_MESSAGE =
  "Your plan's limit for running sandboxes is already in use — stop one before starting another.";

/**
 * Human-facing copy for the PER-SESSION conversation ceiling (issue #2262
 * finding 2) — a different quota from {@link SESSION_QUOTA_MESSAGE}'s
 * account-wide sandbox count: this one is about how many conversations ONE
 * session holds, and its remedy is a different session or an existing
 * conversation, never "stop a sandbox".
 */
export const SESSION_CONVERSATION_LIMIT_MESSAGE =
  'This session already holds the maximum number of conversations — continue in an existing one, or start a new session, before adding another.';

/** The 429 for `SessionFullError` (`create-conversation-in-session.ts`) — kept beside its message so the two cannot drift. */
export function sessionConversationLimitExceeded(
  request: Request,
  userId: string,
  sessionId: string,
  /** Which route refused, for the audit trail only — never shown to the caller. */
  route: string,
): NextResponse {
  auditRequest(request, {
    eventType: 'security.rate.limited',
    userId,
    resourceType: 'agent_session',
    resourceId: sessionId,
    details: { reason: 'session_conversation_limit_reached', route },
    riskScore: 0,
  });
  return NextResponse.json({ error: SESSION_CONVERSATION_LIMIT_MESSAGE }, { status: 429 });
}

export function sessionQuotaExceeded(
  request: Request,
  userId: string,
  sessionId: string,
  /** Which route refused, for the audit trail only — never shown to the caller. */
  route: string,
  /** A more specific message from the provisioner, when it had one. */
  detail?: string,
): NextResponse {
  auditRequest(request, {
    eventType: 'security.rate.limited',
    userId,
    resourceType: 'agent_session',
    resourceId: sessionId,
    details: { reason: 'session_limit_reached', route },
    riskScore: 0,
  });
  return NextResponse.json({ error: detail ?? SESSION_QUOTA_MESSAGE }, { status: 429 });
}
