/**
 * The ONE not-found/denied policy for the `/api/agent-workspaces/[workspaceId]/**`
 * route family (review #2261/5).
 *
 * A session that does not exist and a session this requester may not touch
 * used to answer DIFFERENTLY across the family — `GET /[workspaceId]`
 * deliberately collapsed them into one `{ session: null }` (its own doc:
 * "the same answer whether the session never existed or is someone else's,
 * so a probe learns nothing from it"), while every write route (and even
 * GET's OWN denial branch, which contradicted its neighboring comment) split
 * them into 404 vs 403 — letting a requester learn whether a session id is
 * REAL even when they can never touch it, exactly the enumeration the GET
 * doc claims the family refuses.
 *
 * The fix is the family-wide version of what the GET doc already promised:
 * whatever the reason (`session_not_found` or any real denial), the
 * response the CALLER sees is identical. Only the SHAPE of "nothing here"
 * differs per route (a null session, an empty list, a 404 error) — never
 * whether "not yours" can be told apart from "does not exist".
 *
 * Real denials are still audited — this internal trail is the ONLY place the
 * distinction survives, which is exactly right: security monitoring keeps
 * full fidelity, the wire response does not.
 */
import { NextResponse } from 'next/server';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

/**
 * Audit a genuine access denial. Never fired for `session_not_found` — an
 * unknown id (a stale bookmark, a typo) is not suspicious and is the routine
 * cold case every route in the family greets identically; auditing it would
 * flood the security log with noise for a request that touched nothing.
 */
export function auditSessionAccessDenial(
  request: Request,
  userId: string,
  workspaceId: string,
  reason: string,
  route: string,
): void {
  if (reason === 'session_not_found') return;
  auditRequest(request, {
    eventType: 'authz.access.denied',
    userId,
    resourceType: 'agent_session',
    resourceId: workspaceId,
    details: { reason, route },
    riskScore: 0.5,
  });
}

/**
 * The shared response for routes that answer an unavailable session with an
 * ERROR shape (as opposed to a soft empty-collection/null-session 200,
 * which each of those routes still builds itself — see the family doc
 * above). `not_found` and every denial reason land on this SAME 404.
 */
export function workspaceNotFoundOrDenied(
  request: Request,
  userId: string,
  workspaceId: string,
  reason: string,
  route: string,
  message = 'Session not found',
): NextResponse {
  auditSessionAccessDenial(request, userId, workspaceId, reason, route);
  return NextResponse.json({ error: message }, { status: 404 });
}
