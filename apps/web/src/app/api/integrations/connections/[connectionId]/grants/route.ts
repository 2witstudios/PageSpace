import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { getConnectionById, listGrantsByConnection } from '@pagespace/lib/integrations';
import { getDriveAccess } from '@pagespace/lib/services/drive-service';

const AUTH_OPTIONS = { allow: ['session'] as const };

/**
 * GET /api/integrations/connections/[connectionId]/grants
 * List grants for a connection. Only the connection owner or drive member can access.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ connectionId: string }> }
) {
  const { connectionId } = await context.params;
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;

  try {
    const connection = await getConnectionById(db, connectionId);
    if (!connection) {
      return NextResponse.json({ error: 'Connection not found' }, { status: 404 });
    }

    if (connection.userId) {
      // User-scoped: only the connection owner can view grants
      if (connection.userId !== auth.userId) {
        return NextResponse.json({ error: 'Access denied' }, { status: 403 });
      }
    } else if (connection.driveId) {
      // Drive-scoped: only drive members can view grants
      const access = await getDriveAccess(connection.driveId, auth.userId);
      if (!access.isMember) {
        return NextResponse.json({ error: 'Access denied' }, { status: 403 });
      }
    } else {
      // Reject connections with no scope
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }

    const grants = await listGrantsByConnection(db, connectionId);

    const safeGrants = grants.map((g) => ({
      id: g.id,
      agentId: g.agentId,
      connectionId: g.connectionId,
      allowedTools: g.allowedTools,
      deniedTools: g.deniedTools,
      readOnly: g.readOnly,
      createdAt: g.createdAt,
    }));

    return NextResponse.json({ grants: safeGrants, total: safeGrants.length });
  } catch (error) {
    loggers.api.error('Error listing connection grants:', error as Error);
    return NextResponse.json({ error: 'Failed to list grants' }, { status: 500 });
  }
}
