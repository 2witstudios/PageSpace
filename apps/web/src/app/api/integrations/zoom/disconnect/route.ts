import { NextResponse } from 'next/server';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { zoomConnections } from '@pagespace/db/schema/zoom';
import { isOnPrem } from '@pagespace/lib/deployment-mode';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { decrypt } from '@pagespace/lib/encryption/encryption-utils';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

export async function POST(request: Request) {
  if (isOnPrem()) return Response.json({ error: 'Not available' }, { status: 404 });

  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const { userId } = auth;

    const connection = await db.query.zoomConnections.findFirst({
      where: eq(zoomConnections.userId, userId),
    });

    if (!connection) {
      return NextResponse.json({ error: 'No connection found' }, { status: 404 });
    }

    // Best-effort token revocation
    if (connection.accessToken !== 'REVOKED') {
      try {
        const accessToken = await decrypt(connection.accessToken);
        const credentials = Buffer.from(
          `${process.env.ZOOM_OAUTH_CLIENT_ID}:${process.env.ZOOM_OAUTH_CLIENT_SECRET}`
        ).toString('base64');

        await fetch(`https://zoom.us/oauth/revoke?token=${accessToken}`, {
          method: 'POST',
          headers: { Authorization: `Basic ${credentials}` },
        });
      } catch (err) {
        loggers.auth.warn('Failed to revoke Zoom token (continuing with disconnect)', {
          userId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Clear tokens but keep the row (mirrors Google Calendar pattern)
    await db
      .update(zoomConnections)
      .set({
        status: 'disconnected',
        accessToken: 'REVOKED',
        refreshToken: null,
        updatedAt: new Date(),
      })
      .where(eq(zoomConnections.userId, userId));

    loggers.auth.info('Zoom disconnected', { userId });
    auditRequest(request, { eventType: 'auth.token.revoked', userId, details: { tokenType: 'zoom', reason: 'user_disconnect' } });
    auditRequest(request, { eventType: 'data.delete', userId, resourceType: 'zoom_connection', resourceId: connection.id, details: { operation: 'disconnect' } });

    return NextResponse.json({ success: true });
  } catch (error) {
    loggers.api.error('Error disconnecting Zoom', error as Error);
    return NextResponse.json({ error: 'Failed to disconnect' }, { status: 500 });
  }
}
