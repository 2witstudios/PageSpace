/**
 * Close ONE conversation OFF its workspace's grid.
 *
 * DELETE → 200 { ok: true } — a `move` of the thread's node to no parent. The
 * thread stays a MEMBER of the workspace and stays in its listing; only its
 * location changes. This is NOT the history-deleting
 * `ai/page-agents/[agentId]/conversations/[conversationId]` DELETE — closing
 * never touches a thread's history, and (unlike that route) never removes it
 * from the workspace either.
 *
 * **`last_conversation` is gone from this route.** It refused the close of a
 * workspace's last open listing, because that left a workspace holding nothing
 * — contract invariant 3. A `move` cannot produce that state: every member is
 * still a member afterwards, however few are on screen. Closing the last thread
 * now leaves an EMPTY GRID and a workspace that still holds all its threads,
 * exactly as closing the last PANE already did. Ending a workspace stays an
 * explicit act on a different route.
 *
 * Gated by the ordinary session access check (identity + drive membership),
 * NOT the end-access check — closing one thread is a routine write, not the
 * capability-gated act of tearing down the workspace's sandbox. Not
 * found/denied answer the family's uniform 404 (review #2261/5).
 */

import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { checkSessionAccess, closeConversationInSession } from '@/lib/agent-workspaces/agent-workspaces-runtime';
import { workspaceNotFoundOrDenied } from '@/lib/agent-workspaces/workspace-unavailable-response';

const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

const ROUTE = 'agent-workspaces/[workspaceId]/conversations/[conversationId]';

type RouteContext = { params: Promise<{ workspaceId: string; conversationId: string }> };

export async function DELETE(request: Request, context: RouteContext) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;
  const { workspaceId, conversationId } = await context.params;

  const access = await checkSessionAccess(auth.userId, workspaceId);
  if (!access.allowed) {
    return workspaceNotFoundOrDenied(request, auth.userId, workspaceId, access.reason, ROUTE);
  }

  let outcome: Awaited<ReturnType<typeof closeConversationInSession>>;
  try {
    outcome = await closeConversationInSession({ conversationId, userId: auth.userId, workspaceId });
  } catch (error) {
    loggers.api.error(
      'Session conversation close failed',
      error instanceof Error ? error : undefined,
      { workspaceId, conversationId },
    );
    // 500, not 502: `closeConversationInSession` is a pure DB transaction —
    // no sandbox/machine layer involved, unlike the sibling POST (mints a
    // conversation into a sandbox) or the shell/file routes, where 502
    // correctly signals an upstream failure (caught in review).
    return NextResponse.json({ error: 'Could not close this conversation' }, { status: 500 });
  }

  if (outcome === 'not_in_session') {
    // Same "nothing here" shape whether the id never existed or names a
    // conversation some OTHER session owns — an id-guessing caller learns
    // nothing either way.
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
  }

  if (outcome === 'closed') {
    auditRequest(request, {
      eventType: 'data.write',
      userId: auth.userId,
      resourceType: 'agent_session',
      resourceId: workspaceId,
      details: { op: 'close_conversation', conversationId },
    });
  }

  return NextResponse.json({ ok: true });
}
