/**
 * Every local environment the caller OWNS, across all their drives —
 * `GET /api/env-bridge/machines` (GA wave 3, leaf 5). The account page's
 * read: "my machines", wherever they are enrolled, with the drive each
 * belongs to so a row can link to its drive settings page.
 *
 * **Owner-only by construction**: the store selects by
 * `drive_env_local.ownerId = <caller>`. A machine in a drive the caller has
 * since left is still theirs — it is their computer — and still listed, so
 * they can find and revoke it.
 */
import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { isLocalEnvsEnabled } from '@pagespace/lib/services/drive-envs/local-envs-enabled';
import { listOwnerMachines } from '@/lib/drive-envs/drive-envs-runtime';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };

export async function GET(request: Request) {
  if (!isLocalEnvsEnabled()) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) return auth.error;

    const machines = await listOwnerMachines(auth.userId);
    auditRequest(request, { eventType: 'data.read', userId: auth.userId, resourceType: 'drive_env', resourceId: auth.userId, details: { route: 'env-bridge/machines', operation: 'list', rows: machines.length } });
    return NextResponse.json({ machines });
  } catch (error) {
    loggers.api.error('Failed to list local environments', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({ error: 'Failed to list machines' }, { status: 500 });
  }
}
