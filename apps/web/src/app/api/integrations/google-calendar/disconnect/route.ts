import { NextResponse } from 'next/server';
import { db, googleCalendarConnections, calendarEvents, eq, and } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { decrypt } from '@pagespace/lib';
import { loggers } from '@pagespace/lib/server';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

/**
 * POST /api/integrations/google-calendar/disconnect
 * Disconnects Google Calendar integration for the authenticated user.
 * Revokes OAuth token and updates connection status.
 */
export async function POST(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    // Fetch connection
    const connection = await db.query.googleCalendarConnections.findFirst({
      where: eq(googleCalendarConnections.userId, userId),
    });

    if (!connection) {
      return NextResponse.json(
        { error: 'No connection found' },
        { status: 404 }
      );
    }

    // Try to revoke the Google token (best effort)
    try {
      const accessToken = await decrypt(connection.accessToken);
      await fetch(`https://oauth2.googleapis.com/revoke?token=${accessToken}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      loggers.auth.info('Google Calendar token revoked', { userId });
    } catch (error) {
      // Log but don't fail - token might already be expired/revoked
      loggers.auth.warn('Failed to revoke Google token (continuing with disconnect)', {
        userId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }

    // Update connection status to disconnected
    // We keep the record to retain sync metadata, but clear sensitive tokens
    await db
      .update(googleCalendarConnections)
      .set({
        status: 'disconnected',
        statusMessage: 'Disconnected by user',
        // Clear tokens for security (they're revoked anyway)
        accessToken: 'REVOKED',
        refreshToken: 'REVOKED',
        updatedAt: new Date(),
      })
      .where(eq(googleCalendarConnections.userId, userId));

    // Mark all synced events as no longer syncing
    // They remain in the calendar but won't be updated anymore
    await db
      .update(calendarEvents)
      .set({
        googleSyncReadOnly: false, // Allow editing now that sync is off
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(calendarEvents.createdById, userId),
          eq(calendarEvents.syncedFromGoogle, true)
        )
      );

    loggers.auth.info('Google Calendar disconnected', { userId });

    return NextResponse.json({ success: true });
  } catch (error) {
    loggers.api.error('Error disconnecting Google Calendar:', error as Error);
    return NextResponse.json(
      { error: 'Failed to disconnect' },
      { status: 500 }
    );
  }
}
