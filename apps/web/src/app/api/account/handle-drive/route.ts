import { z } from 'zod';
import { db } from '@pagespace/db/db'
import { eq } from '@pagespace/db/operators'
import { drives } from '@pagespace/db/schema/core'
import { isDriveLead } from '@pagespace/lib/permissions/drive-relationship';
import { loadUserDriveRelationships } from '@pagespace/lib/permissions/drive-relationship-loader';
import { isHomeDrive, homeDriveActionError } from '@pagespace/lib/services/drive-guards';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { getActorInfo, logDriveActivity } from '@pagespace/lib/monitoring/activity-logger';
import { deleteConversationsForDrive } from '@pagespace/lib/repositories/conversation-cleanup';
import { reattributeDriveOwnerStorageInTx } from '@pagespace/lib/services/storage-limits';
import { transferDriveOwnership } from '@pagespace/lib/services/drive-service';

const handleDriveBodySchema = z.object({
  driveId: z.string().optional(),
  action: z.string().optional(),
  newOwnerId: z.string().optional(),
});

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

export async function POST(req: Request) {
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }
  const userId = auth.userId;

  try {
    // Typed at the boundary: `newOwnerId` reaches a membership lookup, so an untyped body never does (D-OW-45).
    const parsed = handleDriveBodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return Response.json({ error: 'Drive ID and action are required' }, { status: 400 });
    }
    const { driveId, action, newOwnerId } = parsed.data;

    // Validate inputs
    if (!driveId || !action) {
      return Response.json({ error: 'Drive ID and action are required' }, { status: 400 });
    }

    if (!['delete', 'transfer'].includes(action)) {
      return Response.json({ error: 'Invalid action. Must be "delete" or "transfer"' }, { status: 400 });
    }

    if (action === 'transfer' && !newOwnerId) {
      return Response.json({ error: 'New owner ID is required for transfer action' }, { status: 400 });
    }

    // Verify the drive exists and user is the owner
    const drive = await db.query.drives.findFirst({
      where: eq(drives.id, driveId),
      columns: {
        id: true,
        ownerId: true,
        name: true,
        kind: true,
        orgId: true,
        orgVisibility: true,
      },
    });

    if (!drive) {
      return Response.json({ error: 'Drive not found' }, { status: 404 });
    }

    if (!isDriveLead(userId, drive)) {
      return Response.json({ error: 'You are not the owner of this drive' }, { status: 403 });
    }

    // An org drive is the org's, not the lead's: it is neither deleted nor handed to a drive
    // admin here. Account deletion reassigns its lead to the org Owner (Spec O-7).
    if (drive.orgId) {
      return Response.json(
        { error: 'This drive belongs to an organization. When you delete your account, the organization Owner becomes its lead.' },
        { status: 409 }
      );
    }

    // Home stays bound to its owner. Deleting it here is allowed: this route is
    // account-deletion prep, where the FK cascade would remove Home anyway.
    if (action === 'transfer' && isHomeDrive(drive)) {
      return Response.json({ error: homeDriveActionError(drive, 'transfer') }, { status: 403 });
    }

    if (action === 'transfer' && newOwnerId) {
      // Verify the new owner is an *accepted* admin in the drive. A pending
      // admin (acceptedAt IS NULL) must not receive ownership — they have
      // never authenticated to the drive and cannot consent. Closes Review C2.
      // The org-aware membership reads ACCEPTED rows only; only an effective ADMIN qualifies.
      // A THIRD-PARTY membership fact (the new owner is not the caller): no credential of theirs is involved.
      const newOwner = (await loadUserDriveRelationships(newOwnerId, [drive])).get(drive.id) ?? { isOwner: false, membership: null };

      if (newOwner.membership?.role !== 'ADMIN') {
        return Response.json(
          { error: 'The new owner must be an admin of the drive' },
          { status: 400 }
        );
      }

      // Transfer ownership. A personal drive's stored bytes bill its owner (WAL-9), so they move
      // to the new owner's quota in the same transaction as drives.ownerId.
      // The drive row is LOCKED and re-read inside the transaction (D-OW-64): a concurrent move into
      // an org (or another hand-over) between the check above and this write would otherwise move an
      // org drive's bytes onto a person, or hand over a drive this caller no longer leads.
      // The ownership change goes through transferDriveOwnership (Home-drive guard, owner check) inside
      // this transaction, so the lock above covers it. Imago needs nothing here (IMG-10.10).
      const transferred = await db.transaction(async (tx) => {
        const [locked] = await tx
          .select({ ownerId: drives.ownerId, orgId: drives.orgId })
          .from(drives)
          .where(eq(drives.id, driveId))
          .for('update');
        if (!locked || locked.orgId !== null || !isDriveLead(userId, locked)) return false;
        await transferDriveOwnership(driveId, userId, newOwnerId, tx);
        await reattributeDriveOwnerStorageInTx(tx, { driveId, fromUserId: locked.ownerId, toUserId: newOwnerId });
        return true;
      });
      if (!transferred) {
        return Response.json({ error: 'This drive changed while the transfer was being made. Reload and try again.' }, { status: 409 });
      }

      // Log activity for audit trail
      const actorInfo = await getActorInfo(userId);
      logDriveActivity(userId, 'ownership_transfer', {
        id: driveId,
        name: drive.name,
      }, {
        ...actorInfo,
        previousValues: { ownerId: userId },
        newValues: { ownerId: newOwnerId },
      });

      loggers.auth.info(`Drive ownership transferred: ${driveId} from ${userId} to ${newOwnerId}`);

      auditRequest(req, { eventType: 'data.write', userId, resourceType: 'drive', resourceId: driveId, details: { operation: 'ownership_transfer', newOwnerId } });

      return Response.json({
        success: true,
        message: 'Drive ownership transferred successfully',
        action: 'transfer',
      });
    }

    if (action === 'delete') {
      // Delete the drive (CASCADE will handle members and pages). Chat history
      // is NOT part of that cascade — `conversations.contextId` is not a
      // foreign key — so it goes first, explicitly, while the drive's pages
      // still exist to be traced through. This route is account-deletion prep,
      // which makes it an Article 17 path: leaving conversations behind would
      // strand their messages and `ai_stream_sessions.parts` content.
      await db.transaction(async (tx) => {
        await deleteConversationsForDrive(tx, driveId);
        await tx.delete(drives).where(eq(drives.id, driveId));
      });

      loggers.auth.info(`Drive deleted during account deletion preparation: ${driveId} by ${userId}`);

      auditRequest(req, { eventType: 'data.delete', userId, resourceType: 'drive', resourceId: driveId, details: { operation: 'drive_delete' } });

      return Response.json({
        success: true,
        message: 'Drive deleted successfully',
        action: 'delete',
      });
    }

    return Response.json({ error: 'Invalid action' }, { status: 400 });
  } catch (error) {
    loggers.auth.error('Error handling drive:', error as Error);
    return Response.json({ error: 'Failed to handle drive' }, { status: 500 });
  }
}
