import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { db, activityLogs, eq, and, desc, gte, lt, inArray } from '@pagespace/db';
import { loggers, auditRequest } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError, checkMCPDriveScope, checkMCPPageScope, getAllowedDriveIds } from '@/lib/auth';
import { canUserViewPage, isUserDriveMember } from '@pagespace/lib';
import { format } from 'date-fns';

const AUTH_OPTIONS = { allow: ['session', 'mcp'] as const, requireCSRF: false };

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

function escapeCsvField(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function toCsvLine(fields: string[]): string {
  return fields.map(escapeCsvField).join(',') + '\n';
}

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

  auditRequest(request, { eventType: 'data.export', userId, resourceType: 'activities', resourceId: 'self' });

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
          // Check MCP token scope before drive access
          const scopeError = checkMCPDriveScope(auth, params.driveId);
          if (scopeError) return scopeError;

          const canViewDrive = await isUserDriveMember(userId, params.driveId);
          if (!canViewDrive) {
            return NextResponse.json(
              { error: 'Unauthorized - you do not have access to this drive' },
              { status: 403 }
            );
          }
          userConditions.push(eq(activityLogs.driveId, params.driveId));
        } else {
          // Filter by MCP token scope when no driveId provided
          const allowedDriveIds = getAllowedDriveIds(auth);
          if (allowedDriveIds.length > 0) {
            userConditions.push(inArray(activityLogs.driveId, allowedDriveIds));
          }
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

        // Check MCP token scope before page access
        const scopeError = await checkMCPPageScope(auth, params.pageId);
        if (scopeError) return scopeError;

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

    const CSV_HEADERS = [
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

    const BATCH_SIZE = 1000;
    const encoder = new TextEncoder();

    // Stream CSV rows directly to the response to avoid buffering the entire
    // dataset in memory. Uses (timestamp, id) as the sort key pair so that
    // offset pagination is stable even when many rows share the same timestamp.
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let exportedCount = 0;
        try {
          controller.enqueue(encoder.encode(toCsvLine(CSV_HEADERS)));

          let batchOffset = 0;
          for (;;) {
            const batch = await db.query.activityLogs.findMany({
              where: finalWhereCondition,
              with: {
                user: {
                  columns: { id: true, name: true, email: true },
                },
              },
              orderBy: [desc(activityLogs.timestamp), desc(activityLogs.id)],
              limit: BATCH_SIZE,
              offset: batchOffset,
            });

            for (const activity of batch) {
              controller.enqueue(encoder.encode(toCsvLine([
                format(new Date(activity.timestamp), 'yyyy-MM-dd HH:mm:ss'),
                activity.actorDisplayName || activity.user?.name || '',
                activity.actorEmail || activity.user?.email || '',
                activity.operation,
                activity.resourceType,
                activity.resourceTitle || '',
                activity.isAiGenerated ? 'Yes' : 'No',
                activity.isAiGenerated ? [activity.aiProvider, activity.aiModel].filter(Boolean).join('/') : '',
                activity.updatedFields ? activity.updatedFields.join(', ') : '',
              ])));
              exportedCount++;
            }

            if (batch.length < BATCH_SIZE) break;
            batchOffset += BATCH_SIZE;
          }

          auditRequest(request, {
            eventType: 'data.export',
            userId,
            resourceType: 'activity',
            resourceId: params.driveId ?? params.pageId ?? '*',
            details: { context: params.context, exportedCount },
          });

          controller.close();
        } catch (err) {
          loggers.api.error('Error streaming activities export:', err as Error);
          controller.error(err);
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
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
