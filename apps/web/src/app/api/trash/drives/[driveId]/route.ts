import { NextResponse } from 'next/server';
import { decodeToken } from '@pagespace/lib/server';
import { parse } from 'cookie';
import { drives, db, eq, and } from '@pagespace/db';
import { loggers } from '@pagespace/lib/logger-config';
import { broadcastDriveEvent, createDriveEventPayload } from '@/lib/socket-utils';

// Get user ID from cookie
async function getUserId(req: Request): Promise<string | null> {
  const cookieHeader = req.headers.get('cookie');
  if (!cookieHeader) {
    return null;
  }

  const cookies = parse(cookieHeader);
  const authToken = cookies['accessToken'];
  if (!authToken) {
    return null;
  }

  const decoded = await decodeToken(authToken);
  if (!decoded || !decoded.userId) {
    return null;
  }

  return decoded.userId;
}

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
    const userId = await getUserId(request);
    
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

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

    if (!drive.isTrashed) {
      return NextResponse.json({ error: 'Drive must be in trash before permanent deletion' }, { status: 400 });
    }

    // Permanently delete the drive (cascade will delete all pages)
    await db
      .delete(drives)
      .where(eq(drives.id, drive.id));

    // Broadcast drive deletion event (permanent delete)
    await broadcastDriveEvent(
      createDriveEventPayload(drive.id, 'deleted', {
        name: drive.name,
        slug: drive.slug,
      })
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    loggers.api.error('Error permanently deleting drive:', error as Error);
    return NextResponse.json({ error: 'Failed to permanently delete drive' }, { status: 500 });
  }
}