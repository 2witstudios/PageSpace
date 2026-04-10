import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { db, activityLogs, users, eq, and, sql, inArray } from '@pagespace/db';
import { loggers, securityAudit } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError, checkMCPDriveScope, getAllowedDriveIds } from '@/lib/auth';
import { isUserDriveMember } from '@pagespace/lib';

const AUTH_OPTIONS = { allow: ['session', 'mcp'] as const, requireCSRF: false };

// Query parameter schema
const querySchema = z.object({
  context: z.enum(['user', 'drive']),
  driveId: z.string().optional(),
});

/**
 * GET /api/activities/actors
 *
 * Fetch unique actors who have activity logs in a given context.
 * Used to populate the actor filter dropdown.
 */
export async function GET(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }

  const userId = auth.userId;
  const { searchParams } = new URL(request.url);

  securityAudit.logDataAccess(userId, 'read', 'activity_actors', userId).catch((error) => {
    loggers.security.warn('[Activities] audit log failed', { error: error instanceof Error ? error.message : String(error), userId });
  });

  try {
    const parseResult = querySchema.safeParse({
      context: searchParams.get('context') || 'drive',
      driveId: searchParams.get('driveId') ?? undefined,
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
        // For user context, only show the current user as the actor
        const userConditions = [
          eq(activityLogs.userId, userId),
          eq(activityLogs.isArchived, false)
        ];

        // Filter by MCP token scope when no driveId provided
        const allowedDriveIds = getAllowedDriveIds(auth);
        if (allowedDriveIds.length > 0) {
          userConditions.push(inArray(activityLogs.driveId, allowedDriveIds));
        }

        whereCondition = and(...userConditions);
        break;
      }

      case 'drive': {
        if (!params.driveId) {
          return NextResponse.json(
            { error: 'driveId is required for drive context' },
            { status: 400 }
          );
        }

        // Check MCP token scope before drive access
        const scopeError = checkMCPDriveScope(auth, params.driveId);
        if (scopeError) return scopeError;

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

      default:
        return NextResponse.json(
          { error: 'Invalid context' },
          { status: 400 }
        );
    }

    // Get distinct users who have activity in this context
    // Use LEFT JOIN to include activities from deleted users (userId becomes NULL)
    // Fallback to actorDisplayName/actorEmail for deleted users
    // Note: For SELECT DISTINCT, ORDER BY expressions must appear in select list,
    // so we include sortKey and order by it
    const sortExpression = sql<string>`COALESCE(${users.name}, ${activityLogs.actorDisplayName}, ${users.email}, ${activityLogs.actorEmail})`;
    const actors = await db
      .selectDistinct({
        id: users.id,
        name: sql<string>`COALESCE(${users.name}, ${activityLogs.actorDisplayName})`.as('name'),
        email: sql<string>`COALESCE(${users.email}, ${activityLogs.actorEmail})`.as('email'),
        image: users.image,
        sortKey: sortExpression.as('sort_key'),
      })
      .from(activityLogs)
      .leftJoin(users, eq(activityLogs.userId, users.id))
      .where(whereCondition)
      .orderBy(sortExpression);

    return NextResponse.json({ actors });
  } catch (error) {
    loggers.api.error('Error fetching activity actors:', error as Error);
    return NextResponse.json(
      { error: 'Failed to fetch activity actors' },
      { status: 500 }
    );
  }
}
