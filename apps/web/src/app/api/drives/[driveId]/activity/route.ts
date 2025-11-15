import { NextResponse } from 'next/server';
import { getUserDriveAccess } from '@pagespace/lib/server';
import { getDriveActivityFeed } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/server';

const AUTH_OPTIONS = { allow: ['jwt', 'mcp'] as const };

/**
 * GET /api/drives/[driveId]/activity
 * Retrieve activity feed for a drive
 *
 * Query parameters:
 * - limit: Number of events to return (default: 50, max: 100)
 * - offset: Number of events to skip for pagination (default: 0)
 * - filter: Filter by action type or category
 * - fromDate: Filter events from this date (ISO 8601)
 * - toDate: Filter events to this date (ISO 8601)
 * - includeAi: Include AI-generated events (default: true)
 * - includeHuman: Include human-generated events (default: true)
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ driveId: string }> }
) {
  const { driveId } = await context.params;
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }
  const userId = auth.userId;

  try {
    // Check drive access
    const hasAccess = await getUserDriveAccess(userId, driveId);
    if (!hasAccess) {
      return NextResponse.json(
        { error: 'Permission denied', details: 'Drive access required' },
        { status: 403 }
      );
    }

    // Parse query parameters
    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 100);
    const offset = parseInt(searchParams.get('offset') || '0');
    const filter = searchParams.get('filter') || undefined;
    const fromDate = searchParams.get('fromDate') ? new Date(searchParams.get('fromDate')!) : undefined;
    const toDate = searchParams.get('toDate') ? new Date(searchParams.get('toDate')!) : undefined;
    const includeAi = searchParams.get('includeAi') !== 'false';
    const includeHuman = searchParams.get('includeHuman') !== 'false';

    // Build filters
    const filters: {
      actionType?: string;
      startDate?: Date;
      endDate?: Date;
      includeAi?: boolean;
      includeHuman?: boolean;
    } = {};

    if (filter) {
      filters.actionType = filter;
    }
    if (fromDate) {
      filters.startDate = fromDate;
    }
    if (toDate) {
      filters.endDate = toDate;
    }
    filters.includeAi = includeAi;
    filters.includeHuman = includeHuman;

    // Fetch activity feed
    const events = await getDriveActivityFeed(driveId, {
      limit,
      offset,
      ...filters,
    });

    return NextResponse.json({
      driveId,
      events: events.map(event => ({
        id: event.id,
        actionType: event.actionType,
        entityType: event.entityType,
        entityId: event.entityId,
        userId: event.userId,
        isAiAction: event.isAiAction,
        description: event.description,
        reason: event.reason,
        createdAt: event.createdAt,
        user: event.user ? {
          id: event.user.id,
          name: event.user.name,
          image: event.user.image,
        } : null,
        page: event.page ? {
          id: event.page.id,
          title: event.page.title,
          type: event.page.type,
        } : null,
        changes: event.changes,
        metadata: event.metadata,
      })),
      pagination: {
        limit,
        offset,
        total: events.length,
        hasMore: events.length === limit,
      },
      filters: {
        actionType: filter,
        fromDate: fromDate?.toISOString(),
        toDate: toDate?.toISOString(),
        includeAi,
        includeHuman,
      },
    });
  } catch (error) {
    loggers.api.error('Error fetching drive activity:', error as Error);
    return NextResponse.json(
      { error: 'Failed to fetch activity feed' },
      { status: 500 }
    );
  }
}
