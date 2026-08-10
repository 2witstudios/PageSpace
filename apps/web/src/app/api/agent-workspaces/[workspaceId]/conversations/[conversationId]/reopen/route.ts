/**
 * Put ONE conversation back into its workspace — the undo of the sibling
 * `[conversationId]` route's DELETE.
 *
 * POST → 200 { ok: true } — an ADMISSION, and a re-mint. There is no `readmit`
 * in the model: that was a `move` back onto the grid, and it existed only
 * because a closed thread kept a node with no parent. Closing DESTROYS the
 * node, so a thread that was closed is a member of nothing, and putting it back
 * is an ordinary admission that mints a fresh node for it.
 *
 * **Which is why `session_full` is live on this path.** It is bounded by
 * `MAX_SESSION_CONVERSATIONS` because the cap counts MEMBERSHIP and a close now
 * genuinely frees a slot — so a return has to re-consult the ceiling like any
 * other admission, and can lose. It is answered 409 below rather than folded
 * into the "nothing here" 404: it is the one refusal here a user can resolve.
 *
 * Gated by the same ordinary session access check the close route uses —
 * this is a routine write, not a capability-gated act.
 */

import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { checkSessionAccess, reopenConversationInSession } from '@/lib/agent-workspaces/agent-workspaces-runtime';
import { workspaceNotFoundOrDenied } from '@/lib/agent-workspaces/workspace-unavailable-response';

const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

const ROUTE = 'agent-workspaces/[workspaceId]/conversations/[conversationId]/reopen';

type RouteContext = { params: Promise<{ workspaceId: string; conversationId: string }> };

export async function POST(request: Request, context: RouteContext) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;
  const { workspaceId, conversationId } = await context.params;

  const access = await checkSessionAccess(auth.userId, workspaceId);
  if (!access.allowed) {
    return workspaceNotFoundOrDenied(request, auth.userId, workspaceId, access.reason, ROUTE);
  }

  let outcome: Awaited<ReturnType<typeof reopenConversationInSession>>;
  try {
    outcome = await reopenConversationInSession({ conversationId, userId: auth.userId, workspaceId });
  } catch (error) {
    loggers.api.error(
      'Session conversation reopen failed',
      error instanceof Error ? error : undefined,
      { workspaceId, conversationId },
    );
    return NextResponse.json({ error: 'Could not reopen this conversation' }, { status: 500 });
  }

  if (outcome === 'not_in_session' || outcome === 'history_deleted') {
    // Same "nothing here" shape whether the id never existed, names a
    // conversation some OTHER session owns, or was history-deleted — an
    // id-guessing caller learns nothing either way.
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
  }

  if (outcome === 'awaiting_backfill') {
    // 503, matching `POST /nodes`. The conversation exists and is the caller's;
    // the SERVER has not migrated this workspace yet and no action by the
    // caller changes that. A 404 here would be a lie about a thread the user
    // can see, and would send them looking for it.
    return NextResponse.json(
      { error: 'This session is not ready yet. Its data is still being migrated.', code: 'awaiting_backfill' },
      { status: 503 },
    );
  }

  if (outcome === 'session_full') {
    // 409, not 404: the thread exists and is the caller's, and the workspace is
    // simply full. This is the one refusal on this path a user can resolve —
    // close something and retry — so it says so, rather than joining the
    // "nothing here" shape above and inviting no action at all.
    return NextResponse.json(
      { error: 'This session is full. Close a conversation and try again.' },
      { status: 409 },
    );
  }

  if (outcome === 'reopened') {
    auditRequest(request, {
      eventType: 'data.write',
      userId: auth.userId,
      resourceType: 'agent_session',
      resourceId: workspaceId,
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
