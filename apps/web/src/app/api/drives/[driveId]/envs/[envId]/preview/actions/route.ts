/**
 * `POST /api/drives/[driveId]/envs/[envId]/preview/actions` — switch an
 * environment's dev-server preview off or back on.
 *
 * OWNER/ADMIN only (`isPrincipalDriveOwnerOrAdmin`) — the same bar as every
 * other write on the env row (rename, rebuild, delete, the published app's
 * stop/resume). An env's preview is shared by everyone in the drive, so
 * switching it off is a management act; a member acting from inside their
 * own SESSION in the env has the session route for that. The env must belong
 * to the drive in the path (else 404), and it must be a sprite env with a
 * preview row to switch (else 404 with the reason). A RESUME additionally
 * passes the wake gate (`canRunCode` on the drive's payer) — a relay start is
 * compute. Dark unless configured.
 */

import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError, isPrincipalDriveOwnerOrAdmin } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { isDevPreviewConfigured } from '@pagespace/lib/services/sandbox/preview/dev-preview-env';
import { resolveEnvInDrive } from '@/lib/drive-envs/drive-envs-runtime';
import { applyDevPreviewUserActionForHolder, authorizePreviewHolderForUser } from '@/lib/dev-preview/preview-runtime';
import { readDevPreviewUserAction } from '@/lib/dev-preview/user-action-body';
import { respondToDevPreviewUserAction } from '@/lib/dev-preview/action-response';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };
const ROUTE = 'drive-envs/preview/actions';

export async function POST(request: Request, context: { params: Promise<{ driveId: string; envId: string }> }) {
  try {
    if (!isDevPreviewConfigured()) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const { driveId, envId } = await context.params;
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;

    const action = readDevPreviewUserAction(await request.json().catch(() => null));
    if (action === null) return NextResponse.json({ error: 'action must be "stop" or "resume"' }, { status: 400 });

    if (!(await isPrincipalDriveOwnerOrAdmin(auth, driveId))) {
      auditRequest(request, { eventType: 'authz.access.denied', userId: auth.userId, resourceType: 'drive', resourceId: driveId, details: { route: ROUTE, envId, action } });
      return NextResponse.json({ error: 'Only the drive owner or an admin can switch an environment preview' }, { status: 403 });
    }
    const env = await resolveEnvInDrive(envId, driveId);
    if (!env) return NextResponse.json({ error: 'Environment not found' }, { status: 404 });
    if (env.substrate !== 'sprite') return NextResponse.json({ error: 'This environment has no sandbox to preview', reason: 'env_not_sprite' }, { status: 404 });

    const holder = { kind: 'env', id: envId } as const;
    // The shared gather's rows-only decision, for its wake subject (the drive's payer).
    const authorization = await authorizePreviewHolderForUser({ holder, userId: auth.userId });
    if (!authorization.allowed) {
      auditRequest(request, { eventType: 'authz.access.denied', userId: auth.userId, resourceType: 'dev_preview', resourceId: `env:${envId}`, details: { route: ROUTE, action, reason: authorization.reason } });
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    const result = await applyDevPreviewUserActionForHolder({ holder, action, userId: auth.userId, wakeSubject: authorization.wakeSubject });
    return respondToDevPreviewUserAction({ request, userId: auth.userId, route: ROUTE, holder, action, result });
  } catch (error) {
    loggers.api.error('Failed to apply env preview action', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({ error: 'Failed to apply preview action' }, { status: 500 });
  }
}
