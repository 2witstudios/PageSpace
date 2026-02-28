import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { getConnectionById, listGrantsByConnection } from '@pagespace/lib/integrations';

const AUTH_OPTIONS = { allow: ['session'] as const };

/**
 * GET /api/integrations/connections/[connectionId]/grants
 * List grants for a connection. Only the connection owner can access.
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

    // Only the connection owner (user-scoped) or a drive member can view grants
    if (connection.userId && connection.userId !== auth.userId) {
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
