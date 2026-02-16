import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db, count, eq, and, integrationAuditLog } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { getDriveAccess } from '@pagespace/lib/services/drive-service';
import { isValidId } from '@pagespace/lib';
import {
  getAuditLogsByDrive,
  getAuditLogsByConnection,
  getAuditLogsBySuccess,
} from '@pagespace/lib/integrations';

const AUTH_OPTIONS = { allow: ['session'] as const };

/**
 * GET /api/drives/[driveId]/integrations/audit
 * List integration audit logs for a drive.
 * Query params: limit, offset, connectionId, success
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
    const limit = Math.min(parseInt(searchParams.get('limit') ?? '50', 10) || 50, 200);
    const offset = parseInt(searchParams.get('offset') ?? '0', 10) || 0;
    const connectionId = searchParams.get('connectionId');
    const successParam = searchParams.get('success');

    if (connectionId && !isValidId(connectionId)) {
      return NextResponse.json({ error: 'Invalid connectionId format' }, { status: 400 });
    }

    // Build where clause by accumulating conditions (always scoped to driveId)
    const conditions = [eq(integrationAuditLog.driveId, driveId)];
    if (connectionId) {
      conditions.push(eq(integrationAuditLog.connectionId, connectionId));
    }
    if (successParam !== null) {
      conditions.push(eq(integrationAuditLog.success, successParam === 'true'));
    }
    const whereClause = conditions.length === 1 ? conditions[0] : and(...conditions);

    // Get total count and paginated logs in parallel
    const [countResult, logs] = await Promise.all([
      db.select({ count: count() }).from(integrationAuditLog).where(whereClause),
      connectionId
        ? getAuditLogsByConnection(db, driveId, connectionId, { limit, offset })
        : successParam !== null
          ? getAuditLogsBySuccess(db, driveId, successParam === 'true', { limit, offset })
          : getAuditLogsByDrive(db, driveId, { limit, offset }),
    ]);

    const total = Number(countResult[0]?.count ?? 0);

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
