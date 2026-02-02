import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { buildTree } from '@pagespace/lib/server';
import { pages, drives, driveMembers, db, and, eq, asc } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

const AUTH_OPTIONS = { allow: ['session', 'mcp'] as const, requireCSRF: true };

const requestSchema = z.object({
  driveId: z.string().min(1, 'Drive ID is required'),
});

export async function POST(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }
  const userId = auth.userId;

  try {
    const body = await request.json();

    const parseResult = requestSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json(
        { error: parseResult.error.issues.map(i => i.message).join('. ') },
        { status: 400 }
      );
    }

    const { driveId } = parseResult.data;

    // Find drive and check access
    const drive = await db.query.drives.findFirst({
      where: eq(drives.id, driveId),
    });

    if (!drive) {
      return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
    }

    // Check authorization
    const isOwner = drive.ownerId === userId;
    let hasAccess = isOwner;

    if (!isOwner) {
      const membership = await db.query.driveMembers.findFirst({
        where: and(
          eq(driveMembers.driveId, driveId),
          eq(driveMembers.userId, userId)
        ),
      });
      hasAccess = !!membership;
    }

    if (!hasAccess) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }

    // Fetch all non-trashed pages for the drive
    const pageResults = await db.query.pages.findMany({
      where: and(
        eq(pages.driveId, driveId),
        eq(pages.isTrashed, false)
      ),
      orderBy: [asc(pages.position)],
    });

    const pageTree = buildTree(pageResults);
    return NextResponse.json({ tree: pageTree });
  } catch (error) {
    loggers.api.error('Error fetching page tree:', error as Error);
    return NextResponse.json(
      { error: 'Failed to fetch page tree' },
      { status: 500 }
    );
  }
}
