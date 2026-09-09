/**
 * `POST /api/drives/[driveId]/envs/[envId]/preview/ports` — the env holder's
 * ports list. See the session route for why POST: the probe is an exec, an
 * exec can wake a paused sprite, and a wake is billed. Gates in the env
 * family's order: manage (drive owner/admin) BEFORE any row read, env-in-drive,
 * sprite substrate, then the rows-only authorization for the wake subject.
 */

import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { isDevPreviewConfigured } from '@pagespace/lib/services/sandbox/preview/dev-preview-env';
import { resolveEnvInDrive } from '@/lib/drive-envs/drive-envs-runtime';
import { authorizePreviewHolderForUser, probeDevPreviewPortsForHolder } from '@/lib/dev-preview/preview-runtime';
import { respondToDevPreviewPorts } from '@/lib/dev-preview/ports-response';
import { canManageDevPreview } from '@/lib/dev-preview/manage-decision';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };
const ROUTE = 'drive-envs/preview/ports';

export async function POST(request: Request, context: { params: Promise<{ driveId: string; envId: string }> }) {
  try {
    if (!isDevPreviewConfigured()) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const { driveId, envId } = await context.params;
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;

    const holder = { kind: 'env', id: envId } as const;
    const manage = await canManageDevPreview(auth, { holder, sessionOwnerId: null, driveId });
    if (!manage.allowed) {
      auditRequest(request, { eventType: 'authz.access.denied', userId: auth.userId, resourceType: 'drive', resourceId: driveId, details: { route: ROUTE, envId, action: 'ports', reason: manage.reason } });
      return NextResponse.json({ error: manage.message }, { status: 403 });
    }
    const env = await resolveEnvInDrive(envId, driveId);
    if (!env) return NextResponse.json({ error: 'Environment not found' }, { status: 404 });
    if (env.substrate !== 'sprite') return NextResponse.json({ error: 'This environment has no sandbox to list ports for', reason: 'env_not_sprite' }, { status: 404 });

    const authorization = await authorizePreviewHolderForUser({ holder, userId: auth.userId });
    if (!authorization.allowed) {
      auditRequest(request, { eventType: 'authz.access.denied', userId: auth.userId, resourceType: 'dev_preview', resourceId: `env:${envId}`, details: { route: ROUTE, action: 'ports', reason: authorization.reason } });
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    const result = await probeDevPreviewPortsForHolder({ holder, userId: auth.userId, wakeSubject: authorization.wakeSubject, sandboxId: authorization.sandboxId });
    return respondToDevPreviewPorts({ request, userId: auth.userId, route: ROUTE, holder, result });
  } catch (error) {
    loggers.api.error('Failed to list env preview ports', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({ error: 'Failed to list ports' }, { status: 500 });
  }
}
