/**
 * A drive's published apps, listed for pickers — `/api/drives/[driveId]/published-apps`.
 *
 * GET → { apps: [{ id, envId, envName, subdomain, url, status }] } — any
 * accepted member of the drive (read-only, no lifecycle verb here).
 *
 * The one consumer today is the custom-domain settings page's target picker
 * (a domain routes to the drive's static site, or to one of these apps — see
 * `custom_domains.publishedAppId`). Kept intentionally thin: full status/URL
 * detail for ONE app already has a home at
 * `/api/drives/[driveId]/envs/[envId]/app`.
 */

import { NextResponse } from 'next/server';
import {
  authenticateRequestWithOptions,
  isAuthError,
  checkMCPDriveScope,
  isPrincipalDriveMember,
} from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { publishedApps } from '@pagespace/db/schema/published-apps';
import { driveEnvs } from '@pagespace/db/schema/drive-envs';
import { resolvePublishedAppsApex } from '@pagespace/lib/services/app-hosting/routing-env';

const AUTH_OPTIONS_READ = { allow: ['session', 'mcp'] as const, requireCSRF: false };

export async function GET(request: Request, context: { params: Promise<{ driveId: string }> }) {
  try {
    const { driveId } = await context.params;
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) return auth.error;

    const scopeError = checkMCPDriveScope(auth, driveId);
    if (scopeError) return scopeError;

    if (!(await isPrincipalDriveMember(auth, driveId))) {
      return NextResponse.json({ error: 'Not a member of this drive' }, { status: 403 });
    }

    const rows = await db
      .select({
        id: publishedApps.id,
        envId: publishedApps.envId,
        envName: driveEnvs.name,
        subdomain: publishedApps.subdomain,
        status: publishedApps.status,
      })
      .from(publishedApps)
      .innerJoin(driveEnvs, eq(driveEnvs.id, publishedApps.envId))
      .where(eq(publishedApps.driveId, driveId));

    const apex = resolvePublishedAppsApex();
    const apps = rows.map((row) => ({
      ...row,
      url: `https://${row.subdomain}.${apex}`,
    }));

    return NextResponse.json({ apps });
  } catch (error) {
    loggers.api.error('Failed to list published apps', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({ error: 'Failed to list published apps' }, { status: 500 });
  }
}
