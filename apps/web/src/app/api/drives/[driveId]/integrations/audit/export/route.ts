import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db, desc, integrationAuditLog } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { getDriveAccess } from '@pagespace/lib/services/drive-service';
import { generateCSV } from '@pagespace/lib/content';
import { format } from 'date-fns';
import { buildAuditLogWhereClause, parseAuditFilterParams } from '../audit-filters';

const AUTH_OPTIONS = { allow: ['session'] as const };
const CSV_HEADERS = [
  'Timestamp',
  'Tool Name',
  'Agent ID',
  'Connection ID',
  'Success',
  'Response Code',
  'Duration (ms)',
  'Error Type',
  'Error Message',
];

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

    const csvData: string[][] = [
      CSV_HEADERS,
      ...logs.map((log) => [
        log.createdAt ? format(new Date(log.createdAt), 'yyyy-MM-dd HH:mm:ss') : '',
        log.toolName ?? '',
        log.agentId ?? '',
        log.connectionId ?? '',
        log.success ? 'Success' : 'Failure',
        log.responseCode != null ? String(log.responseCode) : '',
        log.durationMs != null ? String(log.durationMs) : '',
        log.errorType ?? '',
        log.errorMessage ?? '',
      ]),
    ];

    const csv = generateCSV(csvData);

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
