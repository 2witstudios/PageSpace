import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { db, activityLogs, eq, and, desc, gte, lt } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { generateCSV } from '@pagespace/lib';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { canUserViewPage, isUserDriveMember } from '@pagespace/lib';
import { format } from 'date-fns';

const AUTH_OPTIONS = { allow: ['jwt', 'mcp'] as const, requireCSRF: false };

// Query parameter schema (same as main activities route)
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
});

/**
 * GET /api/activities/export
 *
 * Export activity logs as CSV with current filters applied.
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
    const parseResult = querySchema.safeParse({
      context: searchParams.get('context') || 'user',
      driveId: searchParams.get('driveId') ?? undefined,
      pageId: searchParams.get('pageId') ?? undefined,
      startDate: searchParams.get('startDate') ?? undefined,
      endDate: searchParams.get('endDate') ?? undefined,
      actorId: searchParams.get('actorId') ?? undefined,
      operation: searchParams.get('operation') ?? undefined,
      resourceType: searchParams.get('resourceType') ?? undefined,
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
        if (!params.driveId) {
          return NextResponse.json(
            { error: 'driveId is required for drive context' },
            { status: 400 }
          );
        }

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
        if (!params.pageId) {
          return NextResponse.json(
            { error: 'pageId is required for page context' },
            { status: 400 }
          );
        }

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

    // Fetch all activities (no pagination for export)
    const activities = await db.query.activityLogs.findMany({
      where: finalWhereCondition,
      with: {
        user: {
          columns: { id: true, name: true, email: true },
        },
      },
      orderBy: [desc(activityLogs.timestamp)],
      limit: 10000, // Safety limit
    });

    // Build CSV data
    const headers = [
      'Timestamp',
      'Actor Name',
      'Actor Email',
      'Operation',
      'Resource Type',
      'Resource Title',
      'AI Generated',
      'AI Model',
      'Changed Fields',
    ];

    const rows = activities.map(activity => [
      format(new Date(activity.timestamp), 'yyyy-MM-dd HH:mm:ss'),
      activity.actorDisplayName || activity.user?.name || '',
      activity.actorEmail || activity.user?.email || '',
      activity.operation,
      activity.resourceType,
      activity.resourceTitle || '',
      activity.isAiGenerated ? 'Yes' : 'No',
      activity.isAiGenerated ? [activity.aiProvider, activity.aiModel].filter(Boolean).join('/') : '',
      activity.updatedFields ? activity.updatedFields.join(', ') : '',
    ]);

    const csvData = [headers, ...rows];
    const csvContent = generateCSV(csvData);

    // Generate filename with date range
    let filename = 'activity-export';
    if (params.startDate && params.endDate) {
      filename += `-${format(params.startDate, 'yyyy-MM-dd')}-to-${format(params.endDate, 'yyyy-MM-dd')}`;
    } else if (params.startDate) {
      filename += `-from-${format(params.startDate, 'yyyy-MM-dd')}`;
    } else if (params.endDate) {
      filename += `-until-${format(params.endDate, 'yyyy-MM-dd')}`;
    } else {
      filename += `-${format(new Date(), 'yyyy-MM-dd')}`;
    }
    filename += '.csv';

    // Check if results were truncated
    const isTruncated = activities.length === 10000;

    return new Response(csvContent, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        ...(isTruncated && { 'X-Truncated': 'true', 'X-Truncated-At': '10000' }),
      },
    });
  } catch (error) {
    loggers.api.error('Error exporting activities:', error as Error);
    return NextResponse.json(
      { error: 'Failed to export activities' },
      { status: 500 }
    );
  }
}
