import { NextResponse, after } from 'next/server';
import { db, googleCalendarConnections, eq } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { syncGoogleCalendar } from '@/lib/integrations/google-calendar/sync-service';
import { verifyWebhookToken } from '@/lib/integrations/google-calendar/webhook-token';

type WebhookChannel = { channelId: string; resourceId: string; expiration: string };
type WebhookChannels = Record<string, WebhookChannel>;

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
 * - X-Goog-Channel-Token: Secret token we provided during watch registration
 *
 * We validate the channel token (HMAC) first, then match the channelId
 * against our stored webhook channels as a secondary check.
 */
export async function POST(request: Request) {
  try {
    const channelId = request.headers.get('X-Goog-Channel-ID') || request.headers.get('x-goog-channel-id');
    const resourceId = request.headers.get('X-Goog-Resource-ID') || request.headers.get('x-goog-resource-id');
    const resourceState = request.headers.get('X-Goog-Resource-State') || request.headers.get('x-goog-resource-state');
    const channelToken = request.headers.get('X-Goog-Channel-Token') || request.headers.get('x-goog-channel-token');

    if (!channelId || !resourceId) {
      loggers.api.warn('Google Calendar webhook: missing channel or resource ID');
      return NextResponse.json({ error: 'Missing headers' }, { status: 400 });
    }

    // Initial sync notification - just acknowledge
    if (resourceState === 'sync') {
      loggers.api.info('Google Calendar webhook: sync confirmation received', { channelId });
      return NextResponse.json({ ok: true });
    }

    // Primary auth: validate HMAC token if present
    const tokenUserId = channelToken ? verifyWebhookToken(channelToken) : null;

    let matchedUserId: string | null = tokenUserId;

    // If token auth didn't resolve a userId, fall back to channel lookup
    if (!matchedUserId) {
      const connections = await db.query.googleCalendarConnections.findMany({
        where: eq(googleCalendarConnections.status, 'active'),
        columns: {
          userId: true,
          webhookChannels: true,
        },
      });

      for (const conn of connections) {
        const channels = conn.webhookChannels;
        if (!channels || typeof channels !== 'object') continue;
        const typedChannels = channels as WebhookChannels;
        for (const calId of Object.keys(typedChannels)) {
          const ch = typedChannels[calId];
          if (ch?.channelId === channelId && ch?.resourceId === resourceId) {
            matchedUserId = conn.userId;
            break;
          }
        }
        if (matchedUserId) break;
      }
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

    // Use after() to ensure sync runs to completion even after response is sent
    const userId = matchedUserId;
    after(() => {
      syncGoogleCalendar(userId).catch((error) => {
        loggers.api.error('Google Calendar webhook sync failed', error as Error, {
          userId,
        });
      });
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    loggers.api.error('Google Calendar webhook error:', error as Error);
    // Always return 200 to prevent Google from retrying on server errors
    return NextResponse.json({ ok: true });
  }
}
