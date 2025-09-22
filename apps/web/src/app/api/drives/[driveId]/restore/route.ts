import { NextResponse } from 'next/server';
import { drives, db, eq, and } from '@pagespace/db';
import { loggers } from '@pagespace/lib/logger-config';
import { broadcastDriveEvent, createDriveEventPayload } from '@/lib/socket-utils';
import { authenticateWebRequest, isAuthError } from '@/lib/auth';

export async function POST(
  request: Request,
  context: { params: Promise<{ driveId: string }> }
) {
  try {
    const { driveId } = await context.params;
    const auth = await authenticateWebRequest(request);
    if (isAuthError(auth)) {
      return auth.error;
    }

    const drive = await db.query.drives.findFirst({
      where: and(eq(drives.id, driveId), eq(drives.ownerId, auth.userId)),
    });

    if (!drive) {
      return NextResponse.json({ error: 'Drive not found or access denied' }, { status: 404 });
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

    await broadcastDriveEvent(
      createDriveEventPayload(drive.id, 'updated', {
        name: drive.name,
        slug: drive.slug,
      }),
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    loggers.api.error('Error restoring drive:', error as Error);
    return NextResponse.json({ error: 'Failed to restore drive' }, { status: 500 });
  }
}
