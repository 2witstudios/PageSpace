/**
 * Every environment the GLOBAL ASSISTANT may reach for the caller —
 * `GET /api/env-bridge/environments` (leaf B).
 *
 * A different question from `…/machines`, which answers "every local
 * environment I own" for the account settings page. This one applies TWO
 * conditions, not one: the caller owns the machine AND its owner has made it
 * visible to the global assistant. Visibility defaults off, so a machine the
 * owner has not deliberately switched on never appears here.
 *
 * **Owner-only by construction**: the store selects by
 * `drive_env_local.ownerId = <caller>`, never by a drive role or a drive
 * membership — a drive relationship is not an entitlement to every row inside
 * it. A machine in a drive the caller has since left is still theirs and is
 * still listed, matching `…/machines`.
 *
 * 404 when the feature flag is off, like every other route in this family.
 */
import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { isLocalEnvsEnabled } from '@pagespace/lib/services/drive-envs/local-envs-enabled';
import { listGlobalAssistantEnvironments } from '@/lib/drive-envs/drive-envs-runtime';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };

export async function GET(request: Request) {
  if (!isLocalEnvsEnabled()) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) return auth.error;

    const environments = await listGlobalAssistantEnvironments(auth.userId);
    auditRequest(request, { eventType: 'data.read', userId: auth.userId, resourceType: 'drive_env', resourceId: auth.userId, details: { route: 'env-bridge/environments', operation: 'list', rows: environments.length } });
    return NextResponse.json({ environments });
  } catch (error) {
    loggers.api.error('Failed to list environments visible to the global assistant', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({ error: 'Failed to list environments' }, { status: 500 });
  }
}
