import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { db, activityLogs, eq, and, desc, count, gte, lt } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { canUserViewPage, isUserDriveMember } from '@pagespace/lib';

const AUTH_OPTIONS = { allow: ['session', 'mcp'] as const, requireCSRF: false };

// Query parameter schema
const querySchema = z.object({
  context: z.enum(['user', 'drive', 'page']),
  driveId: z.string().optional(),
  pageId: z.string().optional(),
  // Filter parameters
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
  actorId: z.string().optional(),
  operation: z.string().optional(),
  resourceType: z.string().optional(),
  // Pagination
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * GET /api/activities
 *
 * Fetch activity logs based on context:
 * - user: User's own activity (for dashboard), optionally filtered by driveId
 * - drive: All activity within a drive (for drive view)
 * - page: All edits to a specific page (for page view)
 *
 * Note: actorId filter is only applied in drive/page context since user context
 * already filters by the authenticated user.
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
      // Filter parameters
      startDate: searchParams.get('startDate') ?? undefined,
      endDate: searchParams.get('endDate') ?? undefined,
      actorId: searchParams.get('actorId') ?? undefined,
      operation: searchParams.get('operation') ?? undefined,
      resourceType: searchParams.get('resourceType') ?? undefined,
      // Pagination
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
      case 'user': {
        // User's own activity (dashboard view)
        const userConditions = [
          eq(activityLogs.userId, userId),
          eq(activityLogs.isArchived, false)
        ];

        // Optional drive filter for user context
        if (params.driveId) {
          const canViewDrive = await isUserDriveMember(userId, params.driveId);
          if (!canViewDrive) {
            return NextResponse.json(
              { error: 'Unauthorized - you do not have access to this drive' },
              { status: 403 }
            );
          }
          userConditions.push(eq(activityLogs.driveId, params.driveId));
        }

        whereCondition = and(...userConditions);
        break;
      }

      case 'drive': {
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
      }

      case 'page': {
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
      }

      default:
        return NextResponse.json(
          { error: 'Invalid context' },
          { status: 400 }
        );
    }

    // Apply additional filters
    const filterConditions = [];
    if (whereCondition) {
      filterConditions.push(whereCondition);
    }
    if (params.startDate) {
      filterConditions.push(gte(activityLogs.timestamp, params.startDate));
    }
    if (params.endDate) {
      // Add one day to endDate to include the full day
      const endOfDay = new Date(params.endDate);
      endOfDay.setDate(endOfDay.getDate() + 1);
      filterConditions.push(lt(activityLogs.timestamp, endOfDay));
    }
    // actorId filter only applies in drive/page context (user context already filters by authenticated user)
    if (params.actorId && params.context !== 'user') {
      filterConditions.push(eq(activityLogs.userId, params.actorId));
    }
    if (params.operation) {
      filterConditions.push(eq(activityLogs.operation, params.operation as typeof activityLogs.operation._.data));
    }
    if (params.resourceType) {
      filterConditions.push(eq(activityLogs.resourceType, params.resourceType as typeof activityLogs.resourceType._.data));
    }

    const finalWhereCondition = filterConditions.length > 0
      ? and(...filterConditions)
      : undefined;

    // Fetch activities with user info
    const activities = await db.query.activityLogs.findMany({
      where: finalWhereCondition,
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
      .where(finalWhereCondition);

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
