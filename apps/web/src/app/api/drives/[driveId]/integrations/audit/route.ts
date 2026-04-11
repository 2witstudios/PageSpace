import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db, count, desc, integrationAuditLog } from '@pagespace/db';
import { loggers, auditRequest } from '@pagespace/lib/server';
import { getDriveAccess } from '@pagespace/lib/services/drive-service';
import { buildAuditLogWhereClause, parseAuditListParams } from './audit-filters';

const AUTH_OPTIONS = { allow: ['session'] as const };

/**
 * GET /api/drives/[driveId]/integrations/audit
 * List integration audit logs for a drive.
 * Query params: limit, offset, connectionId, success, agentId, dateFrom, dateTo, toolName
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ driveId: string }> }
) {
  const { driveId } = await context.params;
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;

  try {
    // Require OWNER or ADMIN
    const access = await getDriveAccess(driveId, auth.userId);
    if (!access.isOwner && !access.isAdmin) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const parsedParams = parseAuditListParams(searchParams);
    if (!parsedParams.ok) {
      return NextResponse.json({ error: parsedParams.error }, { status: 400 });
    }
    const { limit, offset, ...filters } = parsedParams.data;
    const whereClause = buildAuditLogWhereClause(driveId, filters);

    // Get total count and paginated logs in parallel
    const [countResult, logs] = await Promise.all([
      db.select({ count: count() }).from(integrationAuditLog).where(whereClause),
      db.query.integrationAuditLog.findMany({
        where: whereClause,
        orderBy: [desc(integrationAuditLog.createdAt)],
        limit,
        offset,
      }),
    ]);

    const total = Number(countResult[0]?.count ?? 0);

    auditRequest(request, { eventType: 'data.read', userId: auth.userId, resourceType: 'integration_audit_log', resourceId: driveId, details: { action: 'view_integration_audit', count: logs.length } });

    return NextResponse.json({
      logs: logs.map((log) => ({
        id: log.id,
        driveId: log.driveId,
        agentId: log.agentId,
        userId: log.userId,
        connectionId: log.connectionId,
        toolName: log.toolName,
        inputSummary: log.inputSummary,
        success: log.success,
        responseCode: log.responseCode,
        errorType: log.errorType,
        errorMessage: log.errorMessage,
        durationMs: log.durationMs,
        createdAt: log.createdAt,
      })),
      total,
    });
  } catch (error) {
    loggers.api.error('Error fetching integration audit logs:', error as Error);
    return NextResponse.json({ error: 'Failed to fetch audit logs' }, { status: 500 });
  }
}
