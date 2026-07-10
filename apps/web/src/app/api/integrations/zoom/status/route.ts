import { NextResponse } from 'next/server';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { zoomConnections } from '@pagespace/db/schema/zoom';
import { isOnPrem } from '@pagespace/lib/deployment-mode';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { authenticateRequestWithOptions } from '@/lib/auth/request-auth';
import { isAuthError } from '@/lib/auth/auth-core';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: false };

export async function GET(request: Request) {
  if (isOnPrem()) return Response.json({ error: 'Not available' }, { status: 404 });

  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const { userId } = auth;

    const connection = await db.query.zoomConnections.findFirst({
      where: eq(zoomConnections.userId, userId),
      columns: {
        id: true,
        status: true,
        zoomEmail: true,
        targetDriveId: true,
        targetFolderId: true,
        includeAiSummary: true,
        includeActionItems: true,
        includeTranscript: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    auditRequest(request, { eventType: 'data.read', userId, resourceType: 'zoom_connection', resourceId: 'self' });

    if (!connection) {
      return NextResponse.json({ connected: false, connection: null });
    }

    return NextResponse.json({
      connected: connection.status === 'active',
      connection,
    });
  } catch (error) {
    loggers.api.error('Error fetching Zoom status', error as Error);
    return NextResponse.json({ error: 'Failed to fetch connection status' }, { status: 500 });
  }
}
