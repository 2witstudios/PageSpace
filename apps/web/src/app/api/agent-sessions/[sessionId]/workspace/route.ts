/**
 * A session's persisted pane grid — columns, panes, and each pane's open
 * conversation tabs, written by the client's own debounced sync
 * (`useWorkspaceServerSync`), never on every layout transition (an earlier
 * "machine workspace" version synced eagerly and was torn down for making
 * every split a write — see `pane-reducer.ts`'s file header).
 *
 * GET  → 200 { workspace: PersistedWorkspaceState | null }
 *   `null` for a session with no saved grid yet (never opened under this
 *   feature) OR one the requester cannot reach — SAME answer either way
 *   (family policy, review #2261/5): a probe learns nothing from the
 *   difference between "doesn't exist" and "not yours".
 *
 * PUT { workspace: unknown } → 200 { ok: true }
 *   Validated against `persistedWorkspaceStateSchema` before it ever reaches
 *   the DB — a malformed payload 400s rather than getting trusted as an `as`
 *   cast, same discipline `persisted-workspace.ts` applies to a localStorage
 *   read of the identical shape.
 */

import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { persistedWorkspaceStateSchema } from '@pagespace/lib/agent-sessions/contract';
import { checkSessionAccess } from '@/lib/agent-sessions/agent-sessions-runtime';
import { getSessionWorkspace, saveSessionWorkspace } from '@/lib/agent-sessions/session-workspace-runtime';
import { auditSessionAccessDenial, sessionNotFoundOrDenied } from '@/lib/agent-sessions/session-unavailable-response';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

const ROUTE = 'agent-sessions/[sessionId]/workspace';

type RouteContext = { params: Promise<{ sessionId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) return auth.error;
  const { sessionId } = await context.params;

  const access = await checkSessionAccess(auth.userId, sessionId);
  if (!access.allowed) {
    auditSessionAccessDenial(request, auth.userId, sessionId, access.reason, ROUTE);
    return NextResponse.json({ workspace: null });
  }

  const workspace = await getSessionWorkspace(sessionId);
  return NextResponse.json({ workspace });
}

export async function PUT(request: Request, context: RouteContext) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;
  const { sessionId } = await context.params;

  const access = await checkSessionAccess(auth.userId, sessionId);
  if (!access.allowed) {
    return sessionNotFoundOrDenied(request, auth.userId, sessionId, access.reason, ROUTE);
  }

  let body: { workspace?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'workspace is required' }, { status: 400 });
  }

  const parsed = persistedWorkspaceStateSchema.safeParse(body.workspace);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid workspace payload', issues: parsed.error.issues }, { status: 400 });
  }

  try {
    await saveSessionWorkspace({ sessionId, workspace: parsed.data });
  } catch (error) {
    loggers.api.error('Session workspace save failed', error instanceof Error ? error : undefined, { sessionId });
    return NextResponse.json({ error: 'Could not save the pane layout' }, { status: 502 });
  }

  auditRequest(request, {
    eventType: 'data.write',
    userId: auth.userId,
    resourceType: 'agent_session',
    resourceId: sessionId,
    details: { op: 'save_workspace' },
  });

  return NextResponse.json({ ok: true });
}
