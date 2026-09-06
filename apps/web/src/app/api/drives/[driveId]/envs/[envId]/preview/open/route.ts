/**
 * `GET /api/drives/[driveId]/envs/[envId]/preview/open` — open an
 * ENVIRONMENT's dev-server preview: the first half of the handshake.
 *
 * Session-authenticated on the app origin (the only place a session lives),
 * gated exactly like the env's own GET (accepted member of the drive; env
 * belongs to the drive in the path, else 404), then re-asked through the
 * shared preview gather so a grant is never minted for a holder the proxy
 * would refuse. Mints a single-use grant and 302s the browser to the holder's
 * dedicated preview origin, whose auth endpoint consumes it and installs the
 * host-only cookie (`preview-grant.ts`).
 *
 * SAME-ORIGIN, OR A TOP-LEVEL NAVIGATION. The dashboard frames this URL; a
 * foreign page must not be able to run the handshake inside its own frame
 * and end up with a preview cookie partitioned under ITS top-level site.
 * `Sec-Fetch-Site`/`Sec-Fetch-Dest` decide (`isAllowedPreviewOpen`): a
 * same-origin request or a top-level `document` navigation (open in a new
 * tab — the preview host sends a cookie-less top-level visit here to re-mint,
 * because a partitioned cookie does not travel to top-level) is admitted; a
 * cross-site embed is refused, and a browser too old to send the headers is
 * refused too (fail closed — they have shipped in every engine since 2023).
 *
 * Dark unless `DEV_PREVIEW_ENABLED=true` and `DEV_PREVIEW_APEX` is set: 404,
 * indistinguishable from a route that does not exist.
 */

import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError, isPrincipalDriveMember } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { isDevPreviewConfigured } from '@pagespace/lib/services/sandbox/preview/dev-preview-env';
import { resolveEnvInDrive } from '@/lib/drive-envs/drive-envs-runtime';
import { isAllowedPreviewOpen, openPreviewForUser, signInOrDeny } from '@/lib/dev-preview/preview-runtime';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: false };
const ROUTE = 'drive-envs/preview/open';

export async function GET(request: Request, context: { params: Promise<{ driveId: string; envId: string }> }) {
  try {
    if (!isDevPreviewConfigured()) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const { driveId, envId } = await context.params;
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return signInOrDeny(request, auth.error);

    if (!isAllowedPreviewOpen(request)) {
      auditRequest(request, { eventType: 'authz.access.denied', userId: auth.userId, resourceType: 'dev_preview', resourceId: `env:${envId}`, details: { route: ROUTE, reason: 'cross-site-embed' }, riskScore: 0.6 });
      return NextResponse.json({ error: 'The preview can only be opened from PageSpace.' }, { status: 403 });
    }
    if (!(await isPrincipalDriveMember(auth, driveId))) {
      auditRequest(request, { eventType: 'authz.access.denied', userId: auth.userId, resourceType: 'drive', resourceId: driveId, details: { route: ROUTE, envId } });
      return NextResponse.json({ error: 'Not a member of this drive' }, { status: 403 });
    }
    if (!(await resolveEnvInDrive(envId, driveId))) return NextResponse.json({ error: 'Environment not found' }, { status: 404 });

    const opened = await openPreviewForUser({ authorizeAs: { kind: 'env', id: envId }, userId: auth.userId });
    if (!opened.ok) {
      if (opened.reason === 'not-authorized') {
        auditRequest(request, { eventType: 'authz.access.denied', userId: auth.userId, resourceType: 'dev_preview', resourceId: `env:${envId}`, details: { route: ROUTE, reason: opened.detail ?? 'not-authorized' } });
      }
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return new NextResponse(null, { status: 302, headers: { location: opened.redirectTo, 'cache-control': 'no-store' } });
  } catch (error) {
    loggers.api.error('Failed to open env preview', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({ error: 'Failed to open preview' }, { status: 500 });
  }
}
