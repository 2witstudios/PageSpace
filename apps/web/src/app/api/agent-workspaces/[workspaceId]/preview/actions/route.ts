/**
 * `POST /api/agent-workspaces/[workspaceId]/preview/actions` — switch a
 * session's dev-server preview off (`{ action: 'stop' }`) or back on
 * (`{ action: 'resume' }`).
 *
 * Authorized as the SESSION (the same access decision as the status read and
 * the open route — the user is acting from inside the session they reached),
 * applied to the HOLDER: for an env-bound session that is the environment's
 * preview, shared by every session in it, which is exactly what the user is
 * looking at. "Stop" records `stoppedByUserAt` (the intent the platform
 * cannot report) and the core stops the relay; "resume" clears it and the
 * core restarts the relay on the row's own target. Neither invents a rule:
 * both are one reconcile through `planDevServerService`.
 *
 * CSRF-guarded write; the family's uniform 404 for unknown/denied; 404 with
 * a reason for a session that has no preview to switch. Dark unless configured.
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

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };
const ROUTE = 'agent-workspaces/[workspaceId]/preview/actions';

export async function POST(request: Request, context: { params: Promise<{ workspaceId: string }> }) {
  try {
    if (!isDevPreviewConfigured()) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const { workspaceId } = await context.params;
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;

    const action = readDevPreviewUserAction(await request.json().catch(() => null));
    if (action === null) return NextResponse.json({ error: 'action must be "stop" or "resume"' }, { status: 400 });

    const session = await findSessionRecord(workspaceId);
    if (!session) return workspaceNotFoundOrDenied(request, auth.userId, workspaceId, 'session_not_found', ROUTE);
    const authorization = await authorizePreviewHolderForUser({ holder: { kind: 'workspace', id: session.id }, userId: auth.userId });
    if (!authorization.allowed) return workspaceNotFoundOrDenied(request, auth.userId, workspaceId, authorization.reason, ROUTE);

    const holder = resolveDevPreviewHolder({ id: session.id, envId: session.envId });
    const result = await applyDevPreviewUserActionForHolder({ holder, action });
    if (!result.ok) return NextResponse.json({ error: 'This session has no dev-server preview to switch', reason: result.reason }, { status: 404 });

    auditRequest(request, {
      eventType: 'data.write',
      userId: auth.userId,
      resourceType: 'dev_preview',
      resourceId: `${holder.kind}:${holder.id}`,
      details: { route: ROUTE, action, applied: result.applied?.action ?? null },
    });
    return NextResponse.json({ ok: true, applied: result.applied });
  } catch (error) {
    loggers.api.error('Failed to apply session preview action', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({ error: 'Failed to apply preview action' }, { status: 500 });
  }
}
