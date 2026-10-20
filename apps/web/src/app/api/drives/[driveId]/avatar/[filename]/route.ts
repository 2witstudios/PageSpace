import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError, getPrincipalDriveAccess } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { serveAvatarFile } from '@/lib/avatars/avatar-route';
import { actorFromAuth, deniedResponse } from '@/lib/auth/request-actor';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: false };

/**
 * GET /api/drives/[driveId]/avatar/[filename] — the drive's avatar image, for whoever can reach the
 * drive (the same people its drive list shows it to). Anyone else gets a 404, so whether a drive
 * exists is never told to an outsider.
 */
export async function GET(request: Request, context: { params: Promise<{ driveId: string; filename: string }> }) {
  const { driveId, filename } = await context.params;
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;
  if (!(await getPrincipalDriveAccess(auth, driveId))) {
    // Every refusal is audited; a successful read is not (a row per rendered tile would swamp the log).
    auditRequest(request, {
      eventType: 'authz.access.denied',
      userId: auth.userId,
      resourceType: 'drive',
      resourceId: driveId,
      details: { route: 'drive-avatar', operation: 'read' },
    });
    return deniedResponse(actorFromAuth(auth), driveId, new NextResponse('Not Found', { status: 404 }));
  }
  return serveAvatarFile('drive', driveId, filename);
}
