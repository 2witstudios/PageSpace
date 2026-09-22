import { NextResponse } from 'next/server';
import { z } from 'zod';
import { listAccessibleDrives, createDrive, type DriveWithAccess } from '@pagespace/lib/services/drive-service';
import { isReservedDriveName } from '@pagespace/lib/services/drive-guards';
import { resolveDriveWideCanEdit } from '@pagespace/lib/permissions/membership-queries';
import { db } from '@pagespace/db/db';
import { and, eq, inArray } from '@pagespace/db/operators';
import { drives as drivesTable } from '@pagespace/db/schema/core';
import { broadcastDriveEvent, createDriveEventPayload } from '@/lib/websocket';
import { loggers } from '@pagespace/lib/logging/logger-config'
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { trackDriveOperation } from '@pagespace/lib/monitoring/activity-tracker';
import { authenticateRequestWithOptions, isAuthError, checkMCPCreateScope, isDriveScopedPrincipal, isScopedOAuthAuth, isManageKeysOnly, getAllowedDriveIds, getPrincipalDriveMembership, isPrincipalDriveMember, getPrincipalDriveAccessLevel } from '@/lib/auth';
import { jsonResponse } from '@pagespace/lib/utils/api-utils';
import { getActorInfo, logDriveActivity } from '@pagespace/lib/monitoring/activity-logger';
import { safeParseBody } from '@/lib/validation/parse-body';

const AUTH_OPTIONS_READ = { allow: ['session', 'mcp', 'oauth'] as const, requireCSRF: false, admitNoContentOAuth: true };
const AUTH_OPTIONS_WRITE = { allow: ['session', 'mcp', 'oauth'] as const, requireCSRF: true };

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
  canEditDrive,
}: {
  allowedDriveIds: string[];
  includeTrash: boolean;
  userId: string;
  getMembership: (driveId: string) => ScopedDriveMembership | Promise<ScopedDriveMembership>;
  canEditDrive: (driveId: string) => Promise<boolean>;
}): Promise<DriveWithAccess[]> {
  // eslint-disable-next-line no-restricted-syntax -- pre-existing unbounded findMany, not fixed by Phase 8 (PageSpace epic j44e35jwzlhr54fbmruk3k4i follow-up)
  const rows = await db.query.drives.findMany({
    where: includeTrash
      ? inArray(drivesTable.id, allowedDriveIds)
      : and(inArray(drivesTable.id, allowedDriveIds), eq(drivesTable.isTrashed, false)),
  });

  const resolved = await Promise.all(
    rows.map(async (drive) => {
      const membership = await getMembership(drive.id);
      if (!membership) return null;
      const role = membership.role
        ?? (drive.ownerId === userId ? ('OWNER' as const) : ('MEMBER' as const));
      return { drive, membership, role };
    }),
  );
  const valid = resolved.filter(
    (entry): entry is NonNullable<typeof entry> => entry !== null,
  );

  // Same drive-wide canEdit rule as the session path (#2627), batched once
  // for the whole scoped list.
  const canCreatePagesMap = await resolveDriveWideCanEdit(
    valid.map(({ drive, membership, role }) => ({
      driveId: drive.id,
      role,
      customRoleId: membership.customRoleId,
    })),
  );

  return Promise.all(
    valid.map(async ({ drive, membership, role }) => {
      // The role's drive-wide rule AND what the credential can do at the drive
      // root right now: an explicit role never exceeds its user, and an
      // inherited scope (role: null, a synthesized MEMBER here) carries the
      // owner's ACTUAL permissions, custom role included. Third-party apps
      // read this flag, so it never claims a create the real gate refuses.
      const canCreatePages = (canCreatePagesMap.get(drive.id) ?? false)
        && await canEditDrive(drive.id);
      return {
        ...drive,
        isOwned: membership.role === null && drive.ownerId === userId,
        role,
        canCreatePages,
        lastAccessedAt: null,
      };
    }),
  );
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
    if (isManageKeysOnly(auth)) {
      // The `pagespace keys` wizard's manage_keys credential belongs to the real
      // user and must see which drives exist to scope a new key to — it has no
      // content access, which every content route enforces on its own.
      // user-identity: the manage_keys credential lists its user's drives to scope a new key; otherwise the unscoped-user branch.
      drives = await listAccessibleDrives(userId, { includeTrash, tokenScopable });
    } else if (isDriveScopedPrincipal(auth)) {
      // A drive-scoped credential (mcp_ key or OAuth drive grant) is its own
      // drive member: list exactly its member drives with ITS role, not the
      // owning user's drive universe. A profile-only principal carries a no-drive
      // sentinel and resolves no membership, so it lists nothing.
      drives = await listScopedDrivesWithMembership({
        allowedDriveIds: getAllowedDriveIds(auth),
        includeTrash,
        userId,
        getMembership: async (driveId) => {
          const membership = await getPrincipalDriveMembership(auth, driveId);
          if (!membership || membership.role !== null) return membership;
          return (await isPrincipalDriveMember(auth, driveId)) ? membership : null;
        },
        canEditDrive: async (driveId) => (await getPrincipalDriveAccessLevel(auth, driveId))?.canEdit === true,
      });
    } else if (isScopedOAuthAuth(auth)) {
      // Fail closed: a non-account OAuth credential with no drive rows is not a
      // shape any grant should produce — never let it inherit the full list.
      drives = [];
    } else {
      // user-identity: the manage_keys credential lists its user's drives to scope a new key; otherwise the unscoped-user branch.
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
