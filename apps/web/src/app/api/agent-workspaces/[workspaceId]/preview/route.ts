/**
 * `GET /api/agent-workspaces/[workspaceId]/preview` — the dev-server preview
 * STATUS of a session, for the detection affordance and the preview pane.
 *
 * Session-authenticated, then the ONE session access decision through the
 * shared preview gather (`gatherDevPreviewStatus` ← `authorizePreviewHolder`
 * ← `decideAgentSessionAccess`) — the same verdict every `[workspaceId]`
 * route enforces, mapped onto the family's uniform not-found/denied 404. For
 * an ENV-BOUND session the state read is the ENVIRONMENT's (the holder rule:
 * whoever owns the sprite pointer), while the open path is this session's own
 * `/preview/open`, which authorizes as the session and mints for the env.
 *
 * NEVER PROBES: one control-plane attach, one `services.get`, one signed ask
 * of the realtime tier for the snapshot it already holds. Dark (404, before
 * authentication) unless the feature is configured — the client never calls
 * it then, because the capability route says no, but the route does not rely
 * on that.
 */

import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { isDevPreviewConfigured } from '@pagespace/lib/services/sandbox/preview/dev-preview-env';
import { resolveDevPreviewHolder } from '@pagespace/lib/services/sandbox/preview/dev-preview-core';
import { findSessionRecord } from '@/lib/agent-workspaces/agent-workspaces-runtime';
import { workspaceNotFoundOrDenied } from '@/lib/agent-workspaces/workspace-unavailable-response';
import { readDevPreviewStatusForUser } from '@/lib/dev-preview/preview-runtime';
import { canManageDevPreview } from '@/lib/dev-preview/manage-decision';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: false };
const ROUTE = 'agent-workspaces/[workspaceId]/preview';

export async function GET(request: Request, context: { params: Promise<{ workspaceId: string }> }) {
  try {
    if (!isDevPreviewConfigured()) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const { workspaceId } = await context.params;
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;

    // The gather decides access; this read only resolves WHOSE preview it is.
    const session = await findSessionRecord(workspaceId);
    if (!session) return workspaceNotFoundOrDenied(request, auth.userId, workspaceId, 'session_not_found', ROUTE);
    const holder = resolveDevPreviewHolder({ id: session.id, envId: session.envId });

    // The gather (control-plane attach + realtime ask) and the manage
    // verdict (a drive-role read, only for an env holder) are independent:
    // run them together rather than serialising a query behind a round trip.
    const [result, manage] = await Promise.all([
      readDevPreviewStatusForUser({ authorizeAs: { kind: 'workspace', id: session.id }, holder, userId: auth.userId }),
      canManageDevPreview(auth, { holder, sessionOwnerId: session.ownerId, driveId: session.driveId }),
    ]);
    if (!result.ok) return workspaceNotFoundOrDenied(request, auth.userId, workspaceId, result.detail, ROUTE);
    return NextResponse.json({ preview: { ...result.status, canManage: manage.allowed } }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    loggers.api.error('Failed to read session preview status', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({ error: 'Failed to read preview status' }, { status: 500 });
  }
}
