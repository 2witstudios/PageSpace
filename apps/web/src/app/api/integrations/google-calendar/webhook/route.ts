import { NextResponse } from 'next/server';
import { db, googleCalendarConnections, eq } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { syncGoogleCalendar } from '@/lib/integrations/google-calendar/sync-service';

/**
 * POST /api/integrations/google-calendar/webhook
 *
 * Receives push notifications from Google Calendar API.
 * Google sends a POST request when events change on a watched calendar.
 *
 * Headers from Google:
 * - X-Goog-Channel-ID: The channel ID we provided when setting up the watch
 * - X-Goog-Resource-ID: The resource ID of the watched resource
 * - X-Goog-Resource-State: 'sync' (initial) or 'exists' (change detected)
 * - X-Goog-Message-Number: Sequential message number
 *
 * No authentication needed (Google doesn't send auth headers) but we validate
 * the channel ID against our stored webhook channels.
 */
export async function POST(request: Request) {
  try {
    const channelId = request.headers.get('X-Goog-Channel-ID') || request.headers.get('x-goog-channel-id');
    const resourceId = request.headers.get('X-Goog-Resource-ID') || request.headers.get('x-goog-resource-id');
    const resourceState = request.headers.get('X-Goog-Resource-State') || request.headers.get('x-goog-resource-state');

    if (!channelId || !resourceId) {
      loggers.api.warn('Google Calendar webhook: missing channel or resource ID');
      return NextResponse.json({ error: 'Missing headers' }, { status: 400 });
    }

    // Initial sync notification - just acknowledge
    if (resourceState === 'sync') {
      loggers.api.info('Google Calendar webhook: sync confirmation received', { channelId });
      return NextResponse.json({ ok: true });
    }

    // Look up which user this webhook belongs to by matching channelId in webhookChannels JSONB
    // We need to search all connections for a matching channel
    const connections = await db.query.googleCalendarConnections.findMany({
      where: eq(googleCalendarConnections.status, 'active'),
      columns: {
        userId: true,
        webhookChannels: true,
      },
    });

    // Find the connection that owns this channel
    let matchedUserId: string | null = null;
    for (const conn of connections) {
      const channels = conn.webhookChannels;
      if (!channels) continue;
      for (const calId of Object.keys(channels)) {
        if (channels[calId].channelId === channelId && channels[calId].resourceId === resourceId) {
          matchedUserId = conn.userId;
          break;
        }
      }
      if (matchedUserId) break;
    }

    if (!matchedUserId) {
      loggers.api.warn('Google Calendar webhook: no matching connection found', { channelId, resourceId });
      // Return 200 to prevent Google from retrying
      return NextResponse.json({ ok: true });
    }

    loggers.api.info('Google Calendar webhook: triggering sync', {
      userId: matchedUserId,
      channelId,
      resourceState,
    });

    // Trigger incremental sync for this user (non-blocking)
    // We don't await this - return 200 immediately to Google
    syncGoogleCalendar(matchedUserId).catch((error) => {
      loggers.api.error('Google Calendar webhook sync failed', error as Error, {
        userId: matchedUserId,
      });
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    loggers.api.error('Google Calendar webhook error:', error as Error);
    // Always return 200 to prevent Google from retrying on server errors
    return NextResponse.json({ ok: true });
  }
}
