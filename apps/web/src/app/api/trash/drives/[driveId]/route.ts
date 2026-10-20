import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db } from '@pagespace/db/db'
import { eq } from '@pagespace/db/operators'
import { drives } from '@pagespace/db/schema/core';
import { isHomeDrive, homeDriveActionError } from '@pagespace/lib/services/drive-guards';
import { loggers } from '@pagespace/lib/logging/logger-config'
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { broadcastDriveEvent, createDriveEventPayload } from '@/lib/websocket';
import { getDriveRecipientUserIds } from '@pagespace/lib/services/drive-member-service';
import { deleteConversationsForDrive } from '@pagespace/lib/repositories/conversation-cleanup';
import { loadDriveLeadAuthority } from '@pagespace/lib/permissions/drive-relationship-loader';
import { actorFromAuth, deniedResponse } from '@/lib/auth/request-actor';
import { callDriveAvatarStorage, mintDriveAvatarToken } from '@/lib/drives/drive-avatar-storage';

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

    // Permanent deletion takes lead authority: the lead, or on an org drive an org Owner/Admin (audited)
    const found = await db.query.drives.findFirst({
      where: eq(drives.id, driveId),
    });
    const drive = found && (await loadDriveLeadAuthority(actorFromAuth(auth), found, 'permanent_delete')).allowed ? found : undefined;

    if (!drive) {
      return deniedResponse(actorFromAuth(auth), driveId, NextResponse.json({ error: 'Drive not found or access denied' }, { status: 404 }));
    }

    if (isHomeDrive(drive)) {
      return NextResponse.json({ error: homeDriveActionError(drive, 'trash') }, { status: 403 });
    }

    if (!drive.isTrashed) {
      return NextResponse.json({ error: 'Drive must be in trash before permanent deletion' }, { status: 400 });
    }

    // Get recipients BEFORE deleting (ensures we have valid member list)
    const recipientUserIds = await getDriveRecipientUserIds(drive.id);

    // Minted while the drive still exists, so its avatar folder can be emptied once it is gone.
    // Always, not only when an avatar is set: a replaced or removed file whose best-effort cleanup
    // failed is still in the folder after the column is cleared (as the org delete does, ORG-1).
    const avatarToken = await mintDriveAvatarToken(drive.id, actorFromAuth(auth)).catch(() => null);

    // Permanently delete the drive (cascade will delete all pages).
    //
    // Chat history is NOT covered by that cascade and has to be deleted
    // explicitly, BEFORE the drive goes: `conversations.contextId` is not a
    // foreign key, and once `pages.driveId` cascades the drive's pages away
    // there is nothing left to trace the page-scoped threads through. The
    // `chat_messages.pageId` cascade that used to make this automatic was
    // dropped with the table in migration 0253.
    await db.transaction(async (tx) => {
      await deleteConversationsForDrive(tx, drive.id);
      await tx.delete(drives).where(eq(drives.id, drive.id));
    });

    if (avatarToken) {
      // Best effort: the drive is already gone; a leftover file is logged, never a failed delete.
      const removed = await callDriveAvatarStorage(drive.id, avatarToken, { method: 'DELETE' }).catch((error: unknown) => error);
      if (!(removed instanceof Response) || !removed.ok) loggers.api.warn('Drive avatar folder was not removed', { driveId: drive.id });
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