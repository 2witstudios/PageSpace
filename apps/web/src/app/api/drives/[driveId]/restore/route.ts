import { NextResponse } from 'next/server';
import { db } from '@pagespace/db/db'
import { eq, and } from '@pagespace/db/operators'
import { drives } from '@pagespace/db/schema/core';
import { isHomeDrive, homeDriveActionError } from '@pagespace/lib/services/drive-guards';
import { loggers } from '@pagespace/lib/logging/logger-config'
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { broadcastDriveEvent, createDriveEventPayload } from '@/lib/websocket';
import { getDriveRecipientUserIds } from '@pagespace/lib/services/drive-member-service';
import { getAppDriveMembership } from '@pagespace/lib/permissions/app-permissions';
import { getActorInfo, logDriveActivity } from '@pagespace/lib/monitoring/activity-logger';
import { authenticateRequestWithOptions } from '@/lib/auth/request-auth';
import { isAuthError, isMCPAuthResult, checkMCPDriveScope } from '@/lib/auth/auth-core';
import { isScopedMCPAuth } from '@/lib/auth/principal-permissions';

const AUTH_OPTIONS = { allow: ['session', 'mcp'] as const, requireCSRF: true };

export async function POST(
  request: Request,
  context: { params: Promise<{ driveId: string }> }
) {
  try {
    const { driveId } = await context.params;
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) {
      return auth.error;
    }

    // Check MCP token scope before drive access
    const scopeError = checkMCPDriveScope(auth, driveId);
    if (scopeError) return scopeError;

    // Restoring a drive is owner-only for users. An inherited key uses its
    // owner's identity (same rule); an explicit-role key needs the OWNER role —
    // ADMIN is not enough, mirroring the user-side ownership requirement.
    let scopedExplicitRole: 'OWNER' | 'ADMIN' | 'MEMBER' | null | undefined;
    if (isScopedMCPAuth(auth)) {
      const membership = await getAppDriveMembership(auth.tokenId, driveId);
      if (!membership) {
        return NextResponse.json({ error: 'Drive not found or access denied' }, { status: 404 });
      }
      scopedExplicitRole = membership.role;
      if (scopedExplicitRole !== null && scopedExplicitRole !== 'OWNER') {
        return NextResponse.json({ error: 'Drive not found or access denied' }, { status: 404 });
      }
    }

    const requireUserOwnership = !isScopedMCPAuth(auth) || scopedExplicitRole === null;
    const drive = await db.query.drives.findFirst({
      where: requireUserOwnership
        ? and(eq(drives.id, driveId), eq(drives.ownerId, auth.userId))
        : eq(drives.id, driveId),
    });

    if (!drive) {
      return NextResponse.json({ error: 'Drive not found or access denied' }, { status: 404 });
    }

    if (isHomeDrive(drive)) {
      return NextResponse.json({ error: homeDriveActionError(drive, 'restore') }, { status: 403 });
    }

    if (!drive.isTrashed) {
      return NextResponse.json({ error: 'Drive is not in trash' }, { status: 400 });
    }

    await db
      .update(drives)
      .set({
        isTrashed: false,
        trashedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(drives.id, drive.id));

    const recipientUserIds = await getDriveRecipientUserIds(drive.id);
    await broadcastDriveEvent(
      createDriveEventPayload(drive.id, 'updated', {
        name: drive.name,
        slug: drive.slug,
      }),
      recipientUserIds
    );

    // Log activity for audit trail
    const actorInfo = await getActorInfo(auth.userId);
    const isMCP = isMCPAuthResult(auth);
    logDriveActivity(auth.userId, 'restore', {
      id: driveId,
      name: drive.name,
    }, {
      ...actorInfo,
      metadata: isMCP ? { source: 'mcp' } : undefined,
      previousValues: { isTrashed: true },
      newValues: { isTrashed: false },
    });

    auditRequest(request, { eventType: 'data.write', userId: auth.userId, resourceType: 'drive', resourceId: driveId, details: { operation: 'restore' } });

    return NextResponse.json({ success: true });
  } catch (error) {
    loggers.api.error('Error restoring drive:', error as Error);
    return NextResponse.json({ error: 'Failed to restore drive' }, { status: 500 });
  }
}
