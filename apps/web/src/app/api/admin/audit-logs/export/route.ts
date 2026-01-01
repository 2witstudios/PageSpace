import {
  db,
  activityLogs,
  users,
  eq,
  and,
  desc,
  gte,
  lte,
  sql,
} from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { verifyAdminAuth } from '@/lib/auth';
import { format } from 'date-fns';

/**
 * Escapes a value for CSV format
 * - Wraps in quotes if contains comma, quote, or newline
 * - Escapes quotes by doubling them
 */
function escapeCSVValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }

  let stringValue: string;

  if (value instanceof Date) {
    stringValue = format(value, "yyyy-MM-dd'T'HH:mm:ss.SSSxxx");
  } else if (typeof value === 'object') {
    stringValue = JSON.stringify(value);
  } else {
    stringValue = String(value);
  }

  // Check if escaping is needed
  if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n') || stringValue.includes('\r')) {
    // Escape quotes by doubling them and wrap in quotes
    return `"${stringValue.replace(/"/g, '""')}"`;
  }

  return stringValue;
}

/**
 * CSV column headers
 */
const CSV_HEADERS = [
  'id',
  'timestamp',
  'userId',
  'actorEmail',
  'actorDisplayName',
  'isAiGenerated',
  'aiProvider',
  'aiModel',
  'aiConversationId',
  'operation',
  'resourceType',
  'resourceId',
  'resourceTitle',
  'driveId',
  'pageId',
  'updatedFields',
  'previousValues',
  'newValues',
  'metadata',
  'isArchived',
  'previousLogHash',
  'logHash',
  'chainSeed',
  'userName',
  'userEmail',
];

/**
 * Converts a log entry to a CSV row
 */
function logToCSVRow(log: Record<string, unknown>): string {
  return CSV_HEADERS.map(header => escapeCSVValue(log[header])).join(',');
}

/**
 * GET /api/admin/audit-logs/export
 *
 * Exports audit logs as CSV with streaming to handle large datasets.
 * Supports the same filters as the main audit logs endpoint.
 *
 * Query parameters:
 * - userId: Filter by user ID
 * - operation: Filter by operation type
 * - resourceType: Filter by resource type
 * - dateFrom: Filter from date (ISO format)
 * - dateTo: Filter to date (ISO format)
 * - search: Full-text search in resourceTitle, actorEmail, actorDisplayName
 * - format: Export format (default: csv, only csv supported currently)
 */
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
    const formatParam = url.searchParams.get('format') || 'csv';

    // Only CSV format is supported
    if (formatParam !== 'csv') {
      return Response.json(
        { error: 'Unsupported format. Only CSV is supported.' },
        { status: 400 }
      );
    }

    // Filter parameters (same as main endpoint)
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
      conditions.push(eq(activityLogs.operation, operation as typeof activityLogs.operation.enumValues[number]));
    }

    if (resourceType) {
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
      conditions.push(
        sql`(
          ${activityLogs.resourceTitle} ILIKE ${'%' + search + '%'} OR
          ${activityLogs.actorEmail} ILIKE ${'%' + search + '%'} OR
          ${activityLogs.actorDisplayName} ILIKE ${'%' + search + '%'} OR
          ${activityLogs.resourceId} ILIKE ${'%' + search + '%'}
        )`
      );
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    // Generate filename with timestamp
    const timestamp = format(new Date(), 'yyyy-MM-dd_HH-mm-ss');
    const filename = `audit-logs_${timestamp}.csv`;

    // Create a readable stream for the CSV data
    const encoder = new TextEncoder();

    // Batch size for fetching records
    const BATCH_SIZE = 1000;

    const stream = new ReadableStream({
      async start(controller) {
        try {
          // Write CSV header
          controller.enqueue(encoder.encode(CSV_HEADERS.join(',') + '\n'));

          let offset = 0;
          let hasMoreRecords = true;

          while (hasMoreRecords) {
            // Fetch logs in batches to prevent memory exhaustion
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
                previousLogHash: activityLogs.previousLogHash,
                logHash: activityLogs.logHash,
                chainSeed: activityLogs.chainSeed,
                userName: users.name,
                userEmail: users.email,
              })
              .from(activityLogs)
              .leftJoin(users, eq(activityLogs.userId, users.id))
              .where(whereClause)
              .orderBy(desc(activityLogs.timestamp))
              .limit(BATCH_SIZE)
              .offset(offset);

            // Write each log as a CSV row
            for (const log of logs) {
              const row = logToCSVRow(log as Record<string, unknown>);
              controller.enqueue(encoder.encode(row + '\n'));
            }

            // Check if there are more records
            if (logs.length < BATCH_SIZE) {
              hasMoreRecords = false;
            } else {
              offset += BATCH_SIZE;
            }
          }

          controller.close();
        } catch (error) {
          loggers.api.error('Error streaming audit logs export:', error as Error);
          controller.error(error);
        }
      },
    });

    // Return streaming response with appropriate headers
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Transfer-Encoding': 'chunked',
      },
    });
  } catch (error) {
    loggers.api.error('Error exporting audit logs:', error as Error);
    return Response.json(
      { error: 'Failed to export audit logs' },
      { status: 500 }
    );
  }
}
