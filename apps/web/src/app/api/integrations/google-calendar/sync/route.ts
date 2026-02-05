import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/server';
import { checkDistributedRateLimit, DISTRIBUTED_RATE_LIMITS } from '@pagespace/lib/security';
import { syncGoogleCalendar } from '@/lib/integrations/google-calendar/sync-service';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

/**
 * POST /api/integrations/google-calendar/sync
 * Triggers a Google Calendar sync for the authenticated user.
 */
export async function POST(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    // Rate limit sync requests to prevent resource exhaustion and Google API quota abuse
    const rateLimit = await checkDistributedRateLimit(
      `gcal:sync:user:${userId}`,
      DISTRIBUTED_RATE_LIMITS.LOGIN // ~5 attempts per window
    );

    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: 'Too many sync requests. Please try again later.', retryAfter: rateLimit.retryAfter },
        { status: 429 }
      );
    }

    loggers.api.info('Google Calendar sync requested', { userId });

    const result = await syncGoogleCalendar(userId);

    if (!result.success) {
      return NextResponse.json(
        {
          error: result.error || 'Sync failed',
          eventsCreated: result.eventsCreated,
          eventsUpdated: result.eventsUpdated,
          eventsDeleted: result.eventsDeleted,
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      eventsCreated: result.eventsCreated,
      eventsUpdated: result.eventsUpdated,
      eventsDeleted: result.eventsDeleted,
    });
  } catch (error) {
    loggers.api.error('Error triggering Google Calendar sync:', error as Error);
    return NextResponse.json(
      { error: 'Failed to trigger sync' },
      { status: 500 }
    );
  }
}
