import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { db, activityLogs, eq, and, desc, gte, lt, inArray } from '@pagespace/db';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { authenticateRequestWithOptions, isAuthError, checkMCPDriveScope, checkMCPPageScope, getAllowedDriveIds } from '@/lib/auth';
import { canUserViewPage, isUserDriveMember } from '@pagespace/lib/permissions/permissions';
import { format } from 'date-fns';

const AUTH_OPTIONS = { allow: ['session', 'mcp'] as const, requireCSRF: false };

const querySchema = z.object({
  context: z.enum(['user', 'drive', 'page']),
  driveId: z.string().optional(),
  pageId: z.string().optional(),
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
  actorId: z.string().optional(),
  operation: z.string().optional(),
  resourceType: z.string().optional(),
});

function escapeCsvField(value: string): string {
  if (value.includes('"') || value.includes(',') || value.includes('\n') || value.includes('\r')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function toCsvLine(fields: string[]): string {
  return fields.map(f => escapeCsvField(String(f ?? ''))).join(',') + '\r\n';
}

const BATCH_SIZE = 1000;

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

    let whereCondition;

    switch (params.context) {
      case 'user': {
        const userConditions = [
          eq(activityLogs.userId, userId),
          eq(activityLogs.isArchived, false)
        ];

        if (params.driveId) {
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

    auditRequest(request, {
      eventType: 'data.export',
      userId,
      resourceType: 'activity',
      resourceId: params.driveId ?? params.pageId ?? '*',
      details: { context: params.context },
    });

    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        try {
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
          controller.enqueue(encoder.encode(toCsvLine(headers)));

          let offset = 0;
          while (true) {
            const batch = await db.query.activityLogs.findMany({
              where: finalWhereCondition,
              with: {
                user: {
                  columns: { id: true, name: true, email: true },
                },
              },
              orderBy: [desc(activityLogs.timestamp)],
              limit: BATCH_SIZE,
              offset,
            });

            for (const activity of batch) {
              const row = [
                format(new Date(activity.timestamp), 'yyyy-MM-dd HH:mm:ss'),
                activity.actorDisplayName || activity.user?.name || '',
                activity.actorEmail || activity.user?.email || '',
                activity.operation,
                activity.resourceType,
                activity.resourceTitle || '',
                activity.isAiGenerated ? 'Yes' : 'No',
                activity.isAiGenerated ? [activity.aiProvider, activity.aiModel].filter(Boolean).join('/') : '',
                activity.updatedFields ? activity.updatedFields.join(', ') : '',
              ];
              controller.enqueue(encoder.encode(toCsvLine(row)));
            }

            if (batch.length < BATCH_SIZE) break;
            offset += BATCH_SIZE;
          }

          controller.close();
        } catch (error) {
          loggers.api.error('Error streaming activities export:', error as Error);
          controller.error(error);
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
