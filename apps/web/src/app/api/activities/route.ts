import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { db, activityLogs, eq, and, desc, count } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { canUserViewPage, isUserDriveMember } from '@pagespace/lib';

const AUTH_OPTIONS = { allow: ['jwt', 'mcp'] as const, requireCSRF: false };

// Query parameter schema
const querySchema = z.object({
  context: z.enum(['user', 'drive', 'page']),
  driveId: z.string().optional(),
  pageId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * GET /api/activities
 *
 * Fetch activity logs based on context:
 * - user: User's own activity (for dashboard)
 * - drive: All activity within a drive (for drive view)
 * - page: All edits to a specific page (for page view)
 */
export async function GET(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }

  const userId = auth.userId;
  const { searchParams } = new URL(request.url);

  try {
    // Parse and validate query parameters
    // Note: searchParams.get() returns null, but Zod's .optional() and .default()
    // only work with undefined, so we convert null → undefined
    const parseResult = querySchema.safeParse({
      context: searchParams.get('context') || 'user',
      driveId: searchParams.get('driveId') ?? undefined,
      pageId: searchParams.get('pageId') ?? undefined,
      limit: searchParams.get('limit') ?? undefined,
      offset: searchParams.get('offset') ?? undefined,
    });

    if (!parseResult.success) {
      return NextResponse.json(
        { error: parseResult.error.issues.map(i => i.message).join('. ') },
        { status: 400 }
      );
    }

    const params = parseResult.data;

    // Build where condition based on context
    let whereCondition;

    switch (params.context) {
      case 'user':
        // User's own activity (dashboard view)
        whereCondition = and(
          eq(activityLogs.userId, userId),
          eq(activityLogs.isArchived, false)
        );
        break;

      case 'drive':
        // All activity within a drive
        if (!params.driveId) {
          return NextResponse.json(
            { error: 'driveId is required for drive context' },
            { status: 400 }
          );
        }

        // Verify user can view drive
        const canViewDrive = await isUserDriveMember(userId, params.driveId);
        if (!canViewDrive) {
          return NextResponse.json(
            { error: 'Unauthorized - you do not have access to this drive' },
            { status: 403 }
          );
        }

        whereCondition = and(
          eq(activityLogs.driveId, params.driveId),
          eq(activityLogs.isArchived, false)
        );
        break;

      case 'page':
        // All edits to a specific page
        if (!params.pageId) {
          return NextResponse.json(
            { error: 'pageId is required for page context' },
            { status: 400 }
          );
        }

        // Verify user can view page
        const canViewPage = await canUserViewPage(userId, params.pageId);
        if (!canViewPage) {
          return NextResponse.json(
            { error: 'Unauthorized - you do not have access to this page' },
            { status: 403 }
          );
        }

        whereCondition = and(
          eq(activityLogs.pageId, params.pageId),
          eq(activityLogs.isArchived, false)
        );
        break;

      default:
        return NextResponse.json(
          { error: 'Invalid context' },
          { status: 400 }
        );
    }

    // Fetch activities with user info
    const activities = await db.query.activityLogs.findMany({
      where: whereCondition,
      with: {
        user: {
          columns: { id: true, name: true, email: true, image: true },
        },
      },
      orderBy: [desc(activityLogs.timestamp)],
      limit: params.limit,
      offset: params.offset,
    });

    // Get total count for pagination
    const [countResult] = await db
      .select({ total: count() })
      .from(activityLogs)
      .where(whereCondition);

    const total = countResult?.total ?? 0;

    return NextResponse.json({
      activities,
      pagination: {
        total,
        limit: params.limit,
        offset: params.offset,
        hasMore: params.offset + activities.length < total,
      },
    });
  } catch (error) {
    loggers.api.error('Error fetching activities:', error as Error);
    return NextResponse.json(
      { error: 'Failed to fetch activities' },
      { status: 500 }
    );
  }
}
