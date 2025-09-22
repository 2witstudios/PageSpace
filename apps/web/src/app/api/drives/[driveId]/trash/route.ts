import { NextResponse } from 'next/server';
import { drives, pages, db, and, eq, asc } from '@pagespace/db';
import { buildTree } from '@pagespace/lib/server';
import { loggers } from '@pagespace/lib/logger-config';
import { authenticateWebRequest, isAuthError } from '@/lib/auth';

interface DriveParams {
  driveId: string;
}

export async function GET(request: Request, context: { params: Promise<DriveParams> }) {
  const auth = await authenticateWebRequest(request);
  if (isAuthError(auth)) {
    return auth.error;
  }

  const { driveId } = await context.params;

  try {
    const drive = await db.query.drives.findFirst({
      where: and(eq(drives.id, driveId), eq(drives.ownerId, auth.userId)),
    });

    if (!drive) {
      return NextResponse.json(
        { error: 'Drive not found or you do not have permission to view its trash.' },
        { status: 404 },
      );
    }

    const trashedPages = await db.query.pages.findMany({
      where: and(eq(pages.driveId, drive.id), eq(pages.isTrashed, true)),
      with: {
        children: true,
      },
      orderBy: [asc(pages.position)],
    });

    const tree = buildTree(trashedPages);

    return NextResponse.json(tree);
  } catch (error) {
    loggers.api.error('Failed to fetch trashed pages:', error as Error);
    return NextResponse.json({ error: 'Failed to fetch trashed pages' }, { status: 500 });
  }
}
