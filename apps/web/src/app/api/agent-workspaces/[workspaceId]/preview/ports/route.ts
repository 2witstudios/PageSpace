/**
 * `POST /api/agent-workspaces/[workspaceId]/preview/ports` — what is listening
 * in this session's sandbox, classified, on an explicit user gesture.
 *
 * POST, not GET, on purpose: the probe is an exec, an exec wakes a paused
 * sprite, and a wake is billed. A GET that wakes is unsafe by HTTP semantics
 * — link prefetch or a StrictMode double-render would bill it. The same
 * gates as the actions route, in the same order: session auth + CSRF, the
 * family 404, the holder rule (an env-bound session lists its ENV's sandbox),
 * the manage gate, then the wake gate inside the shared function.
 */

import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { isDevPreviewConfigured } from '@pagespace/lib/services/sandbox/preview/dev-preview-env';
import { resolveDevPreviewHolder } from '@pagespace/lib/services/sandbox/preview/dev-preview-core';
import { findSessionRecord } from '@/lib/agent-workspaces/agent-workspaces-runtime';
import { workspaceNotFoundOrDenied } from '@/lib/agent-workspaces/workspace-unavailable-response';
import { authorizePreviewHolderForUser, probeDevPreviewPortsForHolder } from '@/lib/dev-preview/preview-runtime';
import { respondToDevPreviewPorts } from '@/lib/dev-preview/ports-response';
import { canManageDevPreview } from '@/lib/dev-preview/manage-decision';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };
const ROUTE = 'agent-workspaces/[workspaceId]/preview/ports';

export async function POST(request: Request, context: { params: Promise<{ workspaceId: string }> }) {
  try {
    if (!isDevPreviewConfigured()) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const { workspaceId } = await context.params;
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;

    const session = await findSessionRecord(workspaceId);
    if (!session) return workspaceNotFoundOrDenied(request, auth.userId, workspaceId, 'session_not_found', ROUTE);
    const authorization = await authorizePreviewHolderForUser({ holder: { kind: 'workspace', id: session.id }, userId: auth.userId });
    if (!authorization.allowed) return workspaceNotFoundOrDenied(request, auth.userId, workspaceId, authorization.reason, ROUTE);

    const holder = resolveDevPreviewHolder({ id: session.id, envId: session.envId });
    // Listing ports is the first half of exposing one, so it takes the same
    // authority as sharing: a viewer who may not manage the preview gets no
    // list to pick from.
    const manage = await canManageDevPreview(auth, { holder, sessionOwnerId: session.ownerId, driveId: session.driveId });
    if (!manage.allowed) {
      auditRequest(request, { eventType: 'authz.access.denied', userId: auth.userId, resourceType: 'dev_preview', resourceId: `${holder.kind}:${holder.id}`, details: { route: ROUTE, action: 'ports', reason: manage.reason }, riskScore: 0.5 });
      return NextResponse.json({ error: manage.message }, { status: 403 });
    }

    const result = await probeDevPreviewPortsForHolder({ holder, userId: auth.userId, wakeSubject: authorization.wakeSubject, sandboxId: authorization.sandboxId });
    return respondToDevPreviewPorts({ request, userId: auth.userId, route: ROUTE, holder, result });
  } catch (error) {
    loggers.api.error('Failed to list session preview ports', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({ error: 'Failed to list ports' }, { status: 500 });
  }
}
