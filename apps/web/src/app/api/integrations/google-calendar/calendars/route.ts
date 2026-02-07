import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/server';
import { getValidAccessToken } from '@/lib/integrations/google-calendar/token-refresh';
import { listCalendars } from '@/lib/integrations/google-calendar/api-client';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: false };

/**
 * GET /api/integrations/google-calendar/calendars
 * Lists all Google calendars available to the authenticated user.
 * Used by the settings UI for calendar selection.
 */
export async function GET(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    // Get valid access token
    const tokenResult = await getValidAccessToken(userId);
    if (!tokenResult.success) {
      return NextResponse.json(
        { error: tokenResult.error, requiresReauth: tokenResult.requiresReauth },
        { status: tokenResult.requiresReauth ? 401 : 500 }
      );
    }

    // Fetch calendar list from Google
    const result = await listCalendars(tokenResult.accessToken);

    if (!result.success) {
      return NextResponse.json(
        { error: result.error },
        { status: result.statusCode || 500 }
      );
    }

    // Return calendars sorted: primary first, then by summary
    const calendars = result.data
      .map((cal) => ({
        id: cal.id,
        summary: cal.summary,
        description: cal.description || null,
        timeZone: cal.timeZone || null,
        backgroundColor: cal.backgroundColor || null,
        foregroundColor: cal.foregroundColor || null,
        primary: cal.primary || false,
        accessRole: cal.accessRole,
      }))
      .sort((a, b) => {
        if (a.primary && !b.primary) return -1;
        if (!a.primary && b.primary) return 1;
        return (a.summary || '').localeCompare(b.summary || '');
      });

    return NextResponse.json({ calendars });
  } catch (error) {
    loggers.api.error('Error fetching Google calendars:', error as Error);
    return NextResponse.json(
      { error: 'Failed to fetch calendars' },
      { status: 500 }
    );
  }
}
