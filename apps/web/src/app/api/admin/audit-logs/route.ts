import {
  db,
  activityLogs,
  users,
  eq,
  and,
  or,
  desc,
  count,
  gte,
  lte,
  ilike,
} from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { verifyAdminAuth } from '@/lib/auth';
import { parseBoundedIntParam } from '@/lib/utils/query-params';

export async function GET(request: Request) {
  try {
    // Verify user is authenticated and is an admin
    const adminUser = await verifyAdminAuth(request);

    if (!adminUser) {
      return Response.json(
        { error: 'Unauthorized: Admin access required' },
        { status: 403 }
      );
    }

    // Parse query parameters
    const url = new URL(request.url);
    const page = parseBoundedIntParam(url.searchParams.get('page'), {
      defaultValue: 1,
      min: 1,
      max: 100000,
    });
    const limit = parseBoundedIntParam(url.searchParams.get('limit'), {
      defaultValue: 50,
      min: 1,
      max: 100,
    });
    const offset = (page - 1) * limit;

    // Filter parameters
    const userId = url.searchParams.get('userId');
    const operation = url.searchParams.get('operation');
    const resourceType = url.searchParams.get('resourceType');
    const dateFrom = url.searchParams.get('dateFrom');
    const dateTo = url.searchParams.get('dateTo');
    const search = url.searchParams.get('search');

    // Build filter conditions
    const conditions = [];

    if (userId) {
      conditions.push(eq(activityLogs.userId, userId));
    }

    if (operation) {
      // Cast to the enum type for type safety
      conditions.push(eq(activityLogs.operation, operation as typeof activityLogs.operation.enumValues[number]));
    }

    if (resourceType) {
      // Cast to the enum type for type safety
      conditions.push(eq(activityLogs.resourceType, resourceType as typeof activityLogs.resourceType.enumValues[number]));
    }

    if (dateFrom) {
      const fromDate = new Date(dateFrom);
      if (!isNaN(fromDate.getTime())) {
        conditions.push(gte(activityLogs.timestamp, fromDate));
      }
    }

    if (dateTo) {
      const toDate = new Date(dateTo);
      if (!isNaN(toDate.getTime())) {
        // Add end of day to include the entire day
        toDate.setHours(23, 59, 59, 999);
        conditions.push(lte(activityLogs.timestamp, toDate));
      }
    }

    if (search) {
      // Escape LIKE pattern special characters to prevent pattern injection
      const escapedSearch = search
        .replace(/\\/g, '\\\\')
        .replace(/%/g, '\\%')
        .replace(/_/g, '\\_');
      const searchPattern = `%${escapedSearch}%`;

      // Use Drizzle's ilike function for proper parameterization
      conditions.push(
        or(
          ilike(activityLogs.resourceTitle, searchPattern),
          ilike(activityLogs.actorEmail, searchPattern),
          ilike(activityLogs.actorDisplayName, searchPattern),
          ilike(activityLogs.resourceId, searchPattern)
        )
      );
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    // Get total count for pagination
    const [countResult] = await db
      .select({ count: count() })
      .from(activityLogs)
      .where(whereClause);

    const totalCount = countResult?.count || 0;
    const totalPages = Math.ceil(totalCount / limit);

    // Fetch paginated activity logs with user info
    const logs = await db
      .select({
        id: activityLogs.id,
        timestamp: activityLogs.timestamp,
        userId: activityLogs.userId,
        actorEmail: activityLogs.actorEmail,
        actorDisplayName: activityLogs.actorDisplayName,
        isAiGenerated: activityLogs.isAiGenerated,
        aiProvider: activityLogs.aiProvider,
        aiModel: activityLogs.aiModel,
        aiConversationId: activityLogs.aiConversationId,
        operation: activityLogs.operation,
        resourceType: activityLogs.resourceType,
        resourceId: activityLogs.resourceId,
        resourceTitle: activityLogs.resourceTitle,
        driveId: activityLogs.driveId,
        pageId: activityLogs.pageId,
        updatedFields: activityLogs.updatedFields,
        previousValues: activityLogs.previousValues,
        newValues: activityLogs.newValues,
        metadata: activityLogs.metadata,
        isArchived: activityLogs.isArchived,
        // Hash chain fields
        previousLogHash: activityLogs.previousLogHash,
        logHash: activityLogs.logHash,
        chainSeed: activityLogs.chainSeed,
        // User info (optional join)
        userName: users.name,
        userEmail: users.email,
        userImage: users.image,
      })
      .from(activityLogs)
      .leftJoin(users, eq(activityLogs.userId, users.id))
      .where(whereClause)
      .orderBy(desc(activityLogs.timestamp))
      .limit(limit)
      .offset(offset);

    return Response.json({
      logs,
      pagination: {
        page,
        limit,
        totalCount,
        totalPages,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1,
      },
      filters: {
        userId,
        operation,
        resourceType,
        dateFrom,
        dateTo,
        search,
      },
    });
  } catch (error) {
    loggers.api.error('Error fetching audit logs:', error as Error);
    return Response.json(
      { error: 'Failed to fetch audit logs' },
      { status: 500 }
    );
  }
}
