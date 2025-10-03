import { NextResponse } from 'next/server';
import { drives, pages, driveMembers, db, and, eq, asc } from '@pagespace/db';
import { buildTree } from '@pagespace/lib/server';
import { loggers } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

const AUTH_OPTIONS = { allow: ['jwt', 'mcp'] as const };

interface DriveParams {
  driveId: string;
}

export async function GET(request: Request, context: { params: Promise<DriveParams> }) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }

  const { driveId } = await context.params;

  try {
    // Find the drive first (don't filter by owner yet)
    const drive = await db.query.drives.findFirst({
      where: eq(drives.id, driveId),
    });

    if (!drive) {
      return NextResponse.json(
        { error: 'Drive not found' },
        { status: 404 },
      );
    }

    // Check if user is owner
    const isOwner = drive.ownerId === auth.userId;

    // Check if user is admin
    let isAdmin = false;
    if (!isOwner) {
      const adminMembership = await db.select()
        .from(driveMembers)
        .where(and(
          eq(driveMembers.driveId, driveId),
          eq(driveMembers.userId, auth.userId),
          eq(driveMembers.role, 'ADMIN')
        ))
        .limit(1);

      isAdmin = adminMembership.length > 0;
    }

    // Only owners and admins can view trash
    if (!isOwner && !isAdmin) {
      return NextResponse.json(
        { error: 'Only drive owners and admins can view trash' },
        { status: 403 },
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
