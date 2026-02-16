import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db, count, eq, and, integrationAuditLog } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { getDriveAccess } from '@pagespace/lib/services/drive-service';
import {
  getAuditLogsByDrive,
  getAuditLogsByConnection,
  getAuditLogsBySuccess,
} from '@pagespace/lib/integrations';

const AUTH_OPTIONS = { allow: ['session'] as const };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    const limit = Math.min(parseInt(searchParams.get('limit') ?? '50', 10), 200);
    const offset = parseInt(searchParams.get('offset') ?? '0', 10);
    const connectionId = searchParams.get('connectionId');
    const successParam = searchParams.get('success');

    if (connectionId && !UUID_RE.test(connectionId)) {
      return NextResponse.json({ error: 'Invalid connectionId format' }, { status: 400 });
    }

    // Build where clause for count query (same filters, no limit/offset)
    let whereClause;
    if (connectionId) {
      whereClause = eq(integrationAuditLog.connectionId, connectionId);
    } else if (successParam !== null) {
      whereClause = and(
        eq(integrationAuditLog.driveId, driveId),
        eq(integrationAuditLog.success, successParam === 'true')
      );
    } else {
      whereClause = eq(integrationAuditLog.driveId, driveId);
    }

    // Get total count and paginated logs in parallel
    const [countResult, logs] = await Promise.all([
      db.select({ count: count() }).from(integrationAuditLog).where(whereClause),
      connectionId
        ? getAuditLogsByConnection(db, connectionId, { limit, offset })
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
