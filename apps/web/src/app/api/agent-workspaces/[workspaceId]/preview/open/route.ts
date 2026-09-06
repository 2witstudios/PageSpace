/**
 * `GET /api/agent-workspaces/[workspaceId]/preview/open` — open a SESSION's
 * dev-server preview: the first half of the handshake.
 *
 * Session-authenticated on the app origin, then the ONE session access
 * decision (`decideAgentSessionAccess`, via the shared preview gather) — the
 * same verdict every `[workspaceId]` route enforces, mapped onto the family's
 * uniform not-found/denied policy (an unknown id and a denied one answer
 * identically). Mints a single-use grant and 302s to the session's dedicated
 * preview origin. For an ENV-BOUND session the preview is the environment's
 * (the holder rule: whoever owns the sprite pointer), so the grant names the
 * env and the browser lands on the env's origin — two sessions in one env
 * share one preview.
 *
 * Same-origin only and dark-by-default exactly as the env route
 * (`drives/[driveId]/envs/[envId]/preview/open`), for the same reasons.
 */

import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { isDevPreviewConfigured } from '@pagespace/lib/services/sandbox/preview/dev-preview-env';
import { resolveDevPreviewHolder } from '@pagespace/lib/services/sandbox/preview/dev-preview-core';
import { findSessionRecord } from '@/lib/agent-workspaces/agent-workspaces-runtime';
import { workspaceNotFoundOrDenied } from '@/lib/agent-workspaces/workspace-unavailable-response';
import { isAllowedPreviewOpen, openPreviewForUser } from '@/lib/dev-preview/preview-runtime';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: false };
const ROUTE = 'agent-workspaces/[workspaceId]/preview/open';

export async function GET(request: Request, context: { params: Promise<{ workspaceId: string }> }) {
  try {
    if (!isDevPreviewConfigured()) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const { workspaceId } = await context.params;
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;

    if (!isAllowedPreviewOpen(request)) {
      auditRequest(request, { eventType: 'authz.access.denied', userId: auth.userId, resourceType: 'dev_preview', resourceId: `workspace:${workspaceId}`, details: { route: ROUTE, reason: 'cross-site-embed' }, riskScore: 0.6 });
      return NextResponse.json({ error: 'The preview can only be opened from PageSpace.' }, { status: 403 });
    }

    // The gather below decides access; this read only resolves WHICH holder
    // the session's preview belongs to (the env for an env-bound session).
    const session = await findSessionRecord(workspaceId);
    if (!session) return workspaceNotFoundOrDenied(request, auth.userId, workspaceId, 'session_not_found', ROUTE);
    const holder = resolveDevPreviewHolder({ id: session.id, envId: session.envId });

    // Authorization is the SESSION's (the user reached the preview through
    // the session); the grant is minted for the HOLDER — the env's origin for
    // an env-bound session, the session's own otherwise.
    const opened = await openPreviewForUser({ authorizeAs: { kind: 'workspace', id: session.id }, mintFor: holder, userId: auth.userId });
    if (!opened.ok) {
      return workspaceNotFoundOrDenied(request, auth.userId, workspaceId, opened.reason === 'not-authorized' ? opened.detail ?? 'not-authorized' : opened.reason, ROUTE);
    }
    return new NextResponse(null, { status: 302, headers: { location: opened.redirectTo, 'cache-control': 'no-store' } });
  } catch (error) {
    loggers.api.error('Failed to open session preview', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({ error: 'Failed to open preview' }, { status: 500 });
  }
}
