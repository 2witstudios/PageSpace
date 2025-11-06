import { NextResponse } from 'next/server';
import { db, pages, drives, driveMember, eq, or, sql, inArray } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/server';

const AUTH_OPTIONS = { allow: ['jwt', 'mcp'] as const };

/**
 * GET /api/workflows/agents
 * List all AI_CHAT pages accessible to the user
 * Optionally filter by driveId
 */
export async function GET(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }
  const userId = auth.userId;

  try {
    const { searchParams } = new URL(request.url);
    const driveId = searchParams.get('driveId');

    // Get all drives the user has access to
    const accessibleDrives = await db
      .select({ id: drives.id })
      .from(drives)
      .where(
        or(
          eq(drives.ownerId, userId),
          sql`EXISTS (
            SELECT 1 FROM ${driveMember}
            WHERE ${driveMember.driveId} = ${drives.id}
            AND ${driveMember.userId} = ${userId}
          )`
        )
      );

    const accessibleDriveIds = accessibleDrives.map((d) => d.id);

    if (accessibleDriveIds.length === 0) {
      return NextResponse.json({ agents: [] });
    }

    // Build query for AI_CHAT pages
    let query = db
      .select({
        id: pages.id,
        title: pages.title,
        driveId: pages.driveId,
      })
      .from(pages)
      .where(
        sql`${pages.type} = 'AI_CHAT'
        AND ${pages.driveId} IN (${sql.join(accessibleDriveIds.map(id => sql`${id}`), sql`, `)})
        AND ${pages.deletedAt} IS NULL`
      )
      .orderBy(pages.title);

    // Filter by specific drive if requested
    if (driveId) {
      // Check if user has access to this drive
      if (!accessibleDriveIds.includes(driveId)) {
        return NextResponse.json(
          { error: 'Access denied to this drive' },
          { status: 403 }
        );
      }

      query = db
        .select({
          id: pages.id,
          title: pages.title,
          driveId: pages.driveId,
        })
        .from(pages)
        .where(
          sql`${pages.type} = 'AI_CHAT'
          AND ${pages.driveId} = ${driveId}
          AND ${pages.deletedAt} IS NULL`
        )
        .orderBy(pages.title);
    }

    const agents = await query;

    return NextResponse.json({ agents });
  } catch (error) {
    loggers.api.error('Error fetching available agents:', error as Error);
    return NextResponse.json(
      { error: 'Failed to fetch available agents' },
      { status: 500 }
    );
  }
}
