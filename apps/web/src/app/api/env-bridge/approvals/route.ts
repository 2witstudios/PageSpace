/**
 * Every durable approval in force across the machines the caller OWNS —
 * `GET /api/env-bridge/approvals` (GA wave 3, leaf 6). The account page's
 * read (Settings → Local environments), so an owner who is not in any drive
 * can still see — and, row by row through the drive route's DELETE — revoke
 * what their machines will run without asking. This subsumes [D-5].
 *
 * **Owner-only by construction.** No id to check: the mirror store selects
 * by `drive_env_local.ownerId = <caller>`, so a row for a machine the caller
 * merely USED (an approval they hold on someone else's laptop) is that
 * owner's to see, not the caller's — the store test pins it. Each row carries
 * its drive and env so the page can link to the drive settings page and name
 * the revoke route.
 *
 * Read-only. This route — and every other route on the server — can only
 * ever list or revoke an approval; none can send one TO a machine. The
 * suite beside this route reads the source of every approval route and the
 * mirror store to pin that.
 */
import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { isLocalEnvsEnabled } from '@pagespace/lib/services/drive-envs/local-envs-enabled';
import { listOwnerApprovals } from '@/lib/drive-envs/drive-envs-runtime';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };

export async function GET(request: Request) {
  if (!isLocalEnvsEnabled()) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) return auth.error;

    const approvals = await listOwnerApprovals(auth.userId);
    auditRequest(request, { eventType: 'data.read', userId: auth.userId, resourceType: 'drive_env_approval', resourceId: auth.userId, details: { route: 'env-bridge/approvals', operation: 'list', rows: approvals.length } });
    return NextResponse.json({ approvals });
  } catch (error) {
    loggers.api.error('Failed to list local environment approvals', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({ error: 'Failed to list approvals' }, { status: 500 });
  }
}
