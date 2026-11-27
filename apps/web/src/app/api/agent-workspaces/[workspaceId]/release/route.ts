/**
 * POST /api/agent-workspaces/[workspaceId]/release
 *   → 200 { ok: true, releasedConversations }
 *
 * "Previous sessions → End all", step one: free the caller's threads in this
 * session that would AUTO-PROVISION into Home (their own Global Assistant and
 * own-Imago conversations — `releaseAutoProvisionedConversations`), so their
 * next tool call lands in Home instead of re-provisioning this session's own
 * Sprite. The client then ends the session with the ordinary DELETE.
 *
 * Its own route rather than a flag on DELETE, so no request value ever sits in
 * front of a membership write: the gate below runs unconditionally, and what
 * this route does is fixed by the route, not by a parameter.
 *
 * Access: the SAME end-access decision DELETE uses (`checkSessionEndAccess`) —
 * releasing threads out of a session is part of ending it, and an unknown or
 * denied id answers the family's uniform 404. The release itself touches only
 * the caller's OWN threads; anyone else's stay bound.
 *
 * Release-then-end is two requests, so a failed end leaves the released threads
 * already out and the ephemeral Sprite up holding none of them until End all is
 * retried — which ends it cleanly. Nothing is lost: a released thread's next
 * tool call lands in Home.
 */

import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { workspaceNotFoundOrDenied } from '@/lib/agent-workspaces/workspace-unavailable-response';
import { checkSessionEndAccess, releaseAutoProvisionedConversations } from '@/lib/agent-workspaces/agent-workspaces-runtime';
import { actorFromAuth } from '@/lib/auth/request-actor';

const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };
const ROUTE = 'agent-workspaces/[workspaceId]/release';

export async function POST(request: Request, context: { params: Promise<{ workspaceId: string }> }) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;
  const { workspaceId } = await context.params;
  const actor = actorFromAuth(auth);

  const access = await checkSessionEndAccess(actor, workspaceId);
  if (!access.allowed) {
    return workspaceNotFoundOrDenied(request, auth.userId, workspaceId, access.reason, ROUTE);
  }

  let releasedConversations: number;
  try {
    releasedConversations = await releaseAutoProvisionedConversations({ workspaceId, actor });
  } catch (error) {
    loggers.api.error('Could not release conversations from a session', undefined, {
      workspaceId,
      detail: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Could not release this session’s conversations' }, { status: 500 });
  }

  auditRequest(request, {
    eventType: 'data.write',
    userId: auth.userId,
    resourceType: 'agent_session',
    resourceId: workspaceId,
    details: { op: 'release_conversations', releasedConversations, route: ROUTE },
  });

  return NextResponse.json({ ok: true, releasedConversations });
}
