import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db, desc, integrationAuditLog } from '@pagespace/db';
import { loggers } from '@pagespace/lib/logging/logger-config'
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { getDriveAccess } from '@pagespace/lib/services/drive-service';
import { format } from 'date-fns';
import { buildAuditLogWhereClause, parseAuditFilterParams } from '../audit-filters';

const AUTH_OPTIONS = { allow: ['session'] as const };
const CSV_HEADER = [
  'Timestamp',
  'Tool Name',
  'Agent ID',
  'Connection ID',
  'Success',
  'Response Code',
  'Duration (ms)',
  'Error Type',
  'Error Message',
].join(',');

function escapeCsvValue(value: string | number | null): string {
  if (value === null || value === undefined) {
    return '';
  }

  let stringValue = String(value);

  // Prevent spreadsheet formula injection when opening CSV in Excel/Sheets.
  if (/^[\t\r ]*[=+\-@]/.test(stringValue)) {
    stringValue = `'${stringValue}`;
  }

  if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n') || stringValue.includes('\r')) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }

  return stringValue;
}

/**
 * GET /api/drives/[driveId]/integrations/audit/export
 * Export integration audit logs as CSV.
 * Query params: connectionId, success, agentId, dateFrom, dateTo, toolName
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ driveId: string }> }
) {
  const { driveId } = await context.params;
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;

  try {
    const access = await getDriveAccess(driveId, auth.userId);
    if (!access.isOwner && !access.isAdmin) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const parsedFilters = parseAuditFilterParams(searchParams);
    if (!parsedFilters.ok) {
      return NextResponse.json({ error: parsedFilters.error }, { status: 400 });
    }

    const whereClause = buildAuditLogWhereClause(driveId, parsedFilters.data);

    const logs = await db.query.integrationAuditLog.findMany({
      where: whereClause,
      orderBy: [desc(integrationAuditLog.createdAt)],
      limit: 10000,
    });

    const csvRows = logs.map((log) => {
      const timestamp = log.createdAt ? format(new Date(log.createdAt), 'yyyy-MM-dd HH:mm:ss') : '';
      return [
        escapeCsvValue(timestamp),
        escapeCsvValue(log.toolName),
        escapeCsvValue(log.agentId),
        escapeCsvValue(log.connectionId),
        escapeCsvValue(log.success ? 'Success' : 'Failure'),
        escapeCsvValue(log.responseCode),
        escapeCsvValue(log.durationMs),
        escapeCsvValue(log.errorType),
        escapeCsvValue(log.errorMessage),
      ].join(',');
    });

    const csv = `${CSV_HEADER}\n${csvRows.join('\n')}`;

    auditRequest(request, { eventType: 'data.export', userId: auth.userId, resourceType: 'drive', resourceId: driveId, details: { format: 'csv' } });

    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="integration-audit-logs-${format(new Date(), 'yyyy-MM-dd')}.csv"`,
      },
    });
  } catch (error) {
    loggers.api.error('Error exporting integration audit logs:', error as Error);
    return NextResponse.json({ error: 'Failed to export audit logs' }, { status: 500 });
  }
}
