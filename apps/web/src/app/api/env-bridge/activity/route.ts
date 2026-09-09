/**
 * Activity across every machine the caller OWNS — `GET /api/env-bridge/activity`
 * (GA wave 3, leaf 2). The account page's read: the owner may not be looking
 * at any drive, and still has to be able to see what their machines are doing.
 *
 * **Owner-only by construction.** There is no id to check: the store selects
 * rows by `drive_env_local.ownerId = <caller>`, so the result can only ever
 * contain the caller's own machines ([D-6], invariant 13). A request the
 * caller made on someone ELSE's machine is that owner's activity, not the
 * caller's, and is not here (the store test pins that).
 *
 * Session auth only (the account surface); every read audited.
 */
import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { isLocalEnvsEnabled } from '@pagespace/lib/services/drive-envs/local-envs-enabled';
import { GRANT_AUDIT_LIST_LIMIT } from '@pagespace/lib/services/drive-envs/grant-audit-store';
import { listOwnerActivity } from '@/lib/drive-envs/drive-envs-runtime';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };

export async function GET(request: Request) {
  if (!isLocalEnvsEnabled()) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) return auth.error;

    const activity = await listOwnerActivity({ ownerId: auth.userId, limit: GRANT_AUDIT_LIST_LIMIT });
    auditRequest(request, { eventType: 'data.read', userId: auth.userId, resourceType: 'drive_env_activity', resourceId: auth.userId, details: { route: 'env-bridge/activity', operation: 'read', rows: activity.length } });
    return NextResponse.json({ activity });
  } catch (error) {
    loggers.api.error('Failed to read local environment activity', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({ error: 'Failed to read environment activity' }, { status: 500 });
  }
}
