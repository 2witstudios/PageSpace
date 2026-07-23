import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db } from '@pagespace/db/db'
import { eq, and } from '@pagespace/db/operators'
import { drives } from '@pagespace/db/schema/core';
import { isHomeDrive, homeDriveActionError } from '@pagespace/lib/services/drive-guards';
import { loggers } from '@pagespace/lib/logging/logger-config'
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { broadcastDriveEvent, createDriveEventPayload } from '@/lib/websocket';
import { getDriveRecipientUserIds } from '@pagespace/lib/services/drive-member-service';
import {
  collectMachinePageIdsInDrive,
  sweepDanglingMachineRefs,
} from '@/lib/machines/machine-ref-sweep-runtime';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

/**
 * DELETE /api/trash/drives/[driveId]
 * Permanently delete a drive from trash
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ driveId: string }> }
) {
  try {
    const { driveId } = await context.params;

    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    // Find the drive and verify ownership
    const drive = await db.query.drives.findFirst({
      where: and(
        eq(drives.id, driveId),
        eq(drives.ownerId, userId)
      ),
    });

    if (!drive) {
      return NextResponse.json({ error: 'Drive not found or access denied' }, { status: 404 });
    }

    if (isHomeDrive(drive)) {
      return NextResponse.json({ error: homeDriveActionError(drive, 'trash') }, { status: 403 });
    }

    if (!drive.isTrashed) {
      return NextResponse.json({ error: 'Drive must be in trash before permanent deletion' }, { status: 400 });
    }

    // Get recipients BEFORE deleting (ensures we have valid member list)
    const recipientUserIds = await getDriveRecipientUserIds(drive.id);

    // Likewise the drive's MACHINE page ids (issue #2156): the cascade below
    // destroys the pages, but the denormalized MachineRefs copied into agent
    // pages / the global assistant config have no FK to cascade them — and
    // afterwards there is nothing left to learn the ids from.
    const machinePageIds = await collectMachinePageIdsInDrive(drive.id);

    // Permanently delete the drive (cascade will delete all pages)
    await db
      .delete(drives)
      .where(eq(drives.id, drive.id));

    // Drop the refs the cascade just orphaned. Best-effort — the daily purge
    // cron sweeps unscoped, so a failure here only delays the repair.
    if (machinePageIds.length > 0) {
      try {
        await sweepDanglingMachineRefs(machinePageIds);
      } catch (error) {
        loggers.api.warn('Machine-ref sweep after permanent drive delete failed; daily cron will retry', {
          driveId,
          error: error as Error,
        });
      }
    }

    // Broadcast drive deletion event (permanent delete)
    await broadcastDriveEvent(
      createDriveEventPayload(drive.id, 'deleted', {
        name: drive.name,
        slug: drive.slug,
      }),
      recipientUserIds
    );

    auditRequest(request, { eventType: 'data.delete', userId, resourceType: 'drive', resourceId: driveId, details: { source: 'trash' } });

    return NextResponse.json({ success: true });
  } catch (error) {
    loggers.api.error('Error permanently deleting drive:', error as Error);
    return NextResponse.json({ error: 'Failed to permanently delete drive' }, { status: 500 });
  }
}