/**
 * `POST /api/agent-workspaces/[workspaceId]/preview/actions` — switch a
 * session's dev-server preview off (`{ action: 'stop' }`) or back on
 * (`{ action: 'resume' }`).
 *
 * Two gates, in order. First the SESSION access decision (the family's
 * not-found/denied 404 — the same verdict as the status read and the open
 * route). Then the MANAGE bar (`decideDevPreviewManage`, a genuine 403 once
 * the session is known to exist): for an ENV-BOUND session the action lands
 * on the ENVIRONMENT's shared preview, so it requires the env's own write bar
 * (drive owner/admin) — this route is not a way around the env route; for a
 * session-holder preview, the session OWNER (the end-session precedent).
 *
 * "Stop" records `stoppedByUserAt` (the intent the platform cannot report)
 * and the core stops the relay; "resume" first passes the WAKE GATE
 * (`canRunCode` on the holder's payer — a relay start is compute, and on a
 * suspended sprite a billed wake), then clears the intent and the core
 * restarts the relay on the row's own target. Neither invents a rule: both
 * are one reconcile through `planDevServerService`.
 *
 * CSRF-guarded write; 404 with a reason for a session that has no preview to
 * switch. Dark unless configured.
 */

import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { isDevPreviewConfigured } from '@pagespace/lib/services/sandbox/preview/dev-preview-env';
import { resolveDevPreviewHolder } from '@pagespace/lib/services/sandbox/preview/dev-preview-core';
import { findSessionRecord } from '@/lib/agent-workspaces/agent-workspaces-runtime';
import { workspaceNotFoundOrDenied } from '@/lib/agent-workspaces/workspace-unavailable-response';
import { applyDevPreviewUserActionForHolder, authorizePreviewHolderForUser } from '@/lib/dev-preview/preview-runtime';
import { readDevPreviewUserAction } from '@/lib/dev-preview/user-action-body';
import { respondToDevPreviewUserAction } from '@/lib/dev-preview/action-response';
import { canManageDevPreview } from '@/lib/dev-preview/manage-decision';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };
const ROUTE = 'agent-workspaces/[workspaceId]/preview/actions';

export async function POST(request: Request, context: { params: Promise<{ workspaceId: string }> }) {
  try {
    if (!isDevPreviewConfigured()) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const { workspaceId } = await context.params;
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;

    const action = readDevPreviewUserAction(await request.json().catch(() => null));
    if (action === null) return NextResponse.json({ error: 'action must be "stop", "resume", or "approve" with the port shown' }, { status: 400 });

    const session = await findSessionRecord(workspaceId);
    if (!session) return workspaceNotFoundOrDenied(request, auth.userId, workspaceId, 'session_not_found', ROUTE);
    const authorization = await authorizePreviewHolderForUser({ holder: { kind: 'workspace', id: session.id }, userId: auth.userId });
    if (!authorization.allowed) return workspaceNotFoundOrDenied(request, auth.userId, workspaceId, authorization.reason, ROUTE);

    const holder = resolveDevPreviewHolder({ id: session.id, envId: session.envId });
    const manage = await canManageDevPreview(auth, { holder, sessionOwnerId: session.ownerId, driveId: session.driveId });
    if (!manage.allowed) {
      // A denial AFTER the family gate: the caller already knows the session
      // exists, so a genuine 403 leaks nothing new (the `provisioningDenied` precedent).
      auditRequest(request, { eventType: 'authz.access.denied', userId: auth.userId, resourceType: 'dev_preview', resourceId: `${holder.kind}:${holder.id}`, details: { route: ROUTE, action: action.kind, reason: manage.reason }, riskScore: 0.5 });
      return NextResponse.json({ error: manage.message }, { status: 403 });
    }

    const result = await applyDevPreviewUserActionForHolder({ holder, action, userId: auth.userId, wakeSubject: authorization.wakeSubject });
    return respondToDevPreviewUserAction({ request, userId: auth.userId, route: ROUTE, holder, action, result });
  } catch (error) {
    loggers.api.error('Failed to apply session preview action', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({ error: 'Failed to apply preview action' }, { status: 500 });
  }
}
