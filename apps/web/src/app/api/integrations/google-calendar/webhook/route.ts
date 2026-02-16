import { NextResponse, after } from 'next/server';
import { loggers } from '@pagespace/lib/server';
import { syncGoogleCalendar } from '@/lib/integrations/google-calendar/sync-service';
import { validateWebhookAuth } from '@/lib/integrations/google-calendar/webhook-auth';

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
 * Zero-trust authentication:
 * - All sync-triggering requests MUST include a valid HMAC token
 * - No fallback to channel/resource ID lookup
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

    // Initial sync notification - just acknowledge (no auth required for sync confirmation)
    if (resourceState === 'sync') {
      loggers.api.info('Google Calendar webhook: sync confirmation received', { channelId, hasToken: !!channelToken });
      return NextResponse.json({ ok: true });
    }

    // Zero-trust authentication: require valid HMAC token
    const authResult = validateWebhookAuth(channelToken);
    if (authResult instanceof NextResponse) {
      loggers.api.warn('Google Calendar webhook: auth failed', {
        channelId,
        resourceId,
        hasToken: !!channelToken,
      });
      return authResult;
    }

    const { userId } = authResult;

    loggers.api.info('Google Calendar webhook: triggering sync', {
      userId,
      channelId,
      resourceState,
    });

    // Use after() to ensure sync runs to completion even after response is sent
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
    // Return 500 for unexpected errors (don't mask server issues)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
