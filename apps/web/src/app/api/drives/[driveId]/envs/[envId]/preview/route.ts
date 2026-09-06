/**
 * `GET /api/drives/[driveId]/envs/[envId]/preview` — the dev-server preview
 * STATUS of an environment, for the row's detection affordance and the
 * preview pane.
 *
 * Gated exactly like the env's own GET (accepted member of the drive; env
 * belongs to the drive in the path, else 404), then re-asked through the
 * shared preview gather so the read can never answer for a holder the proxy
 * would refuse. Never probes (see the session route). Dark unless configured.
 */

import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError, isPrincipalDriveMember } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { isDevPreviewConfigured } from '@pagespace/lib/services/sandbox/preview/dev-preview-env';
import { resolveEnvInDrive } from '@/lib/drive-envs/drive-envs-runtime';
import { readDevPreviewStatusForUser } from '@/lib/dev-preview/preview-runtime';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: false };
const ROUTE = 'drive-envs/preview';

export async function GET(request: Request, context: { params: Promise<{ driveId: string; envId: string }> }) {
  try {
    if (!isDevPreviewConfigured()) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const { driveId, envId } = await context.params;
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;

    if (!(await isPrincipalDriveMember(auth, driveId))) {
      auditRequest(request, { eventType: 'authz.access.denied', userId: auth.userId, resourceType: 'drive', resourceId: driveId, details: { route: ROUTE, envId } });
      return NextResponse.json({ error: 'Not a member of this drive' }, { status: 403 });
    }
    if (!(await resolveEnvInDrive(envId, driveId))) return NextResponse.json({ error: 'Environment not found' }, { status: 404 });

    const result = await readDevPreviewStatusForUser({ authorizeAs: { kind: 'env', id: envId }, userId: auth.userId });
    if (!result.ok) {
      auditRequest(request, { eventType: 'authz.access.denied', userId: auth.userId, resourceType: 'dev_preview', resourceId: `env:${envId}`, details: { route: ROUTE, reason: result.detail } });
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json({ preview: result.status }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    loggers.api.error('Failed to read env preview status', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({ error: 'Failed to read preview status' }, { status: 500 });
  }
}
