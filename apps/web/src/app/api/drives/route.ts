import { NextResponse } from 'next/server';
import { z } from 'zod';
import { listAccessibleDrives, createDrive, type DriveWithAccess } from '@pagespace/lib/services/drive-service';
import { isReservedDriveName } from '@pagespace/lib/services/drive-guards';
import { getAppDriveMembership, getScopedDriveMembership, hasAppDriveMembership, hasScopedDriveMembership } from '@pagespace/lib/permissions/app-permissions';
import { db } from '@pagespace/db/db';
import { and, eq, inArray } from '@pagespace/db/operators';
import { drives as drivesTable } from '@pagespace/db/schema/core';
import { broadcastDriveEvent, createDriveEventPayload } from '@/lib/websocket';
import { loggers } from '@pagespace/lib/logging/logger-config'
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { trackDriveOperation } from '@pagespace/lib/monitoring/activity-tracker';
import { jsonResponse } from '@pagespace/lib/utils/api-utils';
import { getActorInfo, logDriveActivity } from '@pagespace/lib/monitoring/activity-logger';
import { safeParseBody } from '@/lib/validation/parse-body';
import { authenticateRequestWithOptions } from '@/lib/auth/request-auth';
import { isAuthError, checkMCPCreateScope, isManageKeysOnly } from '@/lib/auth/auth-core';
import { isScopedMCPAuth, isScopedOAuthAuth } from '@/lib/auth/principal-permissions';

const AUTH_OPTIONS_READ = { allow: ['session', 'mcp', 'oauth'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session', 'mcp'] as const, requireCSRF: true };

type ScopedDriveMembership = {
  role: 'OWNER' | 'ADMIN' | 'MEMBER' | null;
  customRoleId: string | null;
} | null;

const createDriveSchema = z.object({
  name: z.preprocess(
    (v) => (typeof v === 'string' ? v : ''),
    z.string().min(1, 'Missing name')
  ),
});

async function listScopedDrivesWithMembership({
  allowedDriveIds,
  includeTrash,
  userId,
  getMembership,
}: {
  allowedDriveIds: string[];
  includeTrash: boolean;
  userId: string;
  getMembership: (driveId: string) => ScopedDriveMembership | Promise<ScopedDriveMembership>;
}): Promise<DriveWithAccess[]> {
  const rows = await db.query.drives.findMany({
    where: includeTrash
      ? inArray(drivesTable.id, allowedDriveIds)
      : and(inArray(drivesTable.id, allowedDriveIds), eq(drivesTable.isTrashed, false)),
  });

  const drives = await Promise.all(
    rows.map(async (drive): Promise<DriveWithAccess | null> => {
      const membership = await getMembership(drive.id);
      if (!membership) return null;
      const role = membership.role
        ?? (drive.ownerId === userId ? ('OWNER' as const) : ('MEMBER' as const));
      return {
        ...drive,
        isOwned: membership.role === null && drive.ownerId === userId,
        role,
        lastAccessedAt: null,
      };
    }),
  );

  return drives.filter((drive): drive is DriveWithAccess => drive !== null);
}

export async function GET(req: Request) {
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) {
    return auth.error;
  }

  const userId = auth.userId;
  loggers.api.debug('[DEBUG] Drives API - User ID:', { userId });

  const url = new URL(req.url);
  const includeTrash = url.searchParams.get('includeTrash') === 'true';
  const tokenScopable = url.searchParams.get('tokenScopable') === 'true';

  try {
    let drives: DriveWithAccess[];
    if (isScopedMCPAuth(auth)) {
      // A scoped MCP token is its own drive member: list exactly its member
      // drives (with the TOKEN's role), not the owning user's drive universe.
      drives = await listScopedDrivesWithMembership({
        allowedDriveIds: auth.allowedDriveIds,
        includeTrash,
        userId,
        getMembership: async (driveId) => {
          const membership = await getAppDriveMembership(auth.tokenId, driveId);
          if (!membership || membership.role !== null) return membership;
          return (await hasAppDriveMembership(auth.tokenId, driveId)) ? membership : null;
        },
      });
    } else if (isScopedOAuthAuth(auth)) {
      if (isManageKeysOnly(auth)) {
        drives = await listAccessibleDrives(userId, { includeTrash, tokenScopable });
      } else if (auth.allowedDriveIds.length > 0) {
        drives = await listScopedDrivesWithMembership({
          allowedDriveIds: auth.allowedDriveIds,
          includeTrash,
          userId,
          getMembership: async (driveId) => {
            const membership = getScopedDriveMembership(auth.driveScopes, driveId);
            if (!membership || membership.role !== null) return membership;
            return (await hasScopedDriveMembership(auth.driveScopes, auth.userId, driveId)) ? membership : null;
          },
        });
      } else {
        drives = [];
      }
    } else {
      drives = await listAccessibleDrives(userId, { includeTrash, tokenScopable });
    }

    loggers.api.debug('[DEBUG] Drives API - Found drives:', {
      count: drives.length,
      drives: drives.map((d) => ({ id: d.id, name: d.name, slug: d.slug })),
    });

    return jsonResponse(drives);
  } catch (error) {
    loggers.api.error('Error fetching drives:', error as Error);
    return NextResponse.json({ error: 'Failed to fetch drives' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) {
    return auth.error;
  }

  // Scoped MCP tokens cannot create new drives
  const scopeError = checkMCPCreateScope(auth, null);
  if (scopeError) {
    return scopeError;
  }

  const userId = auth.userId;

  const parsed = await safeParseBody(request, createDriveSchema);
  if (!parsed.success) {
    return parsed.response;
  }

  const { name } = parsed.data;

  try {
    if (isReservedDriveName(name)) {
      return NextResponse.json({ error: 'Cannot create a drive with that name.' }, { status: 400 });
    }

    const newDrive = await createDrive(userId, { name });

    await broadcastDriveEvent(
      createDriveEventPayload(newDrive.id, 'created', {
        name: newDrive.name,
        slug: newDrive.slug,
      }),
      [userId] // Only the creator receives the event for new drives
    );

    trackDriveOperation(userId, 'create', newDrive.id, {
      name: newDrive.name,
      slug: newDrive.slug,
    });

    // Log activity for audit trail
    const actorInfo = await getActorInfo(userId);
    logDriveActivity(userId, 'create', {
      id: newDrive.id,
      name: newDrive.name,
    }, actorInfo);

    auditRequest(request, { eventType: 'data.write', userId, resourceType: 'drive', resourceId: newDrive.id, details: { name, operation: 'create' } });

    return jsonResponse(newDrive, { status: 201 });
  } catch (error) {
    loggers.api.error('Error creating drive:', error as Error);
    return NextResponse.json({ error: 'Failed to create drive' }, { status: 500 });
  }
}
