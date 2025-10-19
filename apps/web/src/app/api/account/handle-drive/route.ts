import { db, eq, and, drives, driveMembers } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

const AUTH_OPTIONS = { allow: ['jwt'] as const, requireCSRF: true };

export async function POST(req: Request) {
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }
  const userId = auth.userId;

  try {
    const body = await req.json();
    const { driveId, action, newOwnerId } = body;

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
      },
    });

    if (!drive) {
      return Response.json({ error: 'Drive not found' }, { status: 404 });
    }

    if (drive.ownerId !== userId) {
      return Response.json({ error: 'You are not the owner of this drive' }, { status: 403 });
    }

    if (action === 'transfer') {
      // Verify the new owner is an admin in the drive
      const newOwnerMembership = await db.query.driveMembers.findFirst({
        where: and(
          eq(driveMembers.driveId, driveId),
          eq(driveMembers.userId, newOwnerId),
          eq(driveMembers.role, 'ADMIN')
        ),
      });

      if (!newOwnerMembership) {
        return Response.json(
          { error: 'The new owner must be an admin of the drive' },
          { status: 400 }
        );
      }

      // Transfer ownership
      await db
        .update(drives)
        .set({ ownerId: newOwnerId })
        .where(eq(drives.id, driveId));

      loggers.auth.info(`Drive ownership transferred: ${driveId} from ${userId} to ${newOwnerId}`);

      return Response.json({
        success: true,
        message: 'Drive ownership transferred successfully',
        action: 'transfer',
      });
    }

    if (action === 'delete') {
      // Delete the drive (CASCADE will handle members and pages)
      await db.delete(drives).where(eq(drives.id, driveId));

      loggers.auth.info(`Drive deleted during account deletion preparation: ${driveId} by ${userId}`);

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
