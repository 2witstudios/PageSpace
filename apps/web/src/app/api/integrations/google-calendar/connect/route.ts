import { z } from 'zod/v4';
import { db, users, eq } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { checkDistributedRateLimit, DISTRIBUTED_RATE_LIMITS } from '@pagespace/lib/security';
import { authenticateRequestWithOptions, isAuthError, getClientIP } from '@/lib/auth';
import crypto from 'crypto';
import { normalizeGoogleCalendarReturnPath } from '@/lib/integrations/google-calendar/return-url';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

const connectSchema = z.object({
  returnUrl: z.string().optional(),
});

/**
 * Initiates Google Calendar OAuth flow.
 * Requests full calendar read/write scope for two-way sync.
 * User must be authenticated before connecting calendar.
 */
export async function POST(req: Request) {
  try {
    // Validate required OAuth environment variables
    if (
      !process.env.GOOGLE_OAUTH_CLIENT_ID ||
      !process.env.GOOGLE_OAUTH_CLIENT_SECRET ||
      !process.env.OAUTH_STATE_SECRET
    ) {
      loggers.auth.error('Missing required OAuth environment variables for Calendar connect');
      return Response.json({ error: 'OAuth not configured' }, { status: 500 });
    }

    // ZERO-TRUST: User must be authenticated with valid session
    const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    // Fetch user for email hint
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { id: true, email: true },
    });

    if (!user) {
      return Response.json({ error: 'User not found' }, { status: 404 });
    }

    let body;
    try {
      body = await req.json();
    } catch {
      body = {};
    }
    const validation = connectSchema.safeParse(body);

    if (!validation.success) {
      return Response.json({ errors: validation.error.flatten().fieldErrors }, { status: 400 });
    }

    const returnUrl = normalizeGoogleCalendarReturnPath(validation.data.returnUrl);

    // Rate limiting by user ID (more restrictive for integration connections)
    const clientIP = getClientIP(req);
    const rateLimit = await checkDistributedRateLimit(
      `gcal:connect:user:${userId}`,
      DISTRIBUTED_RATE_LIMITS.LOGIN
    );

    if (!rateLimit.allowed) {
      return Response.json(
        { error: 'Too many connection attempts. Please try again later.', retryAfter: rateLimit.retryAfter },
        { status: 429 }
      );
    }

    // Build callback URL for calendar-specific OAuth
    const baseUrl = process.env.WEB_APP_URL || process.env.NEXTAUTH_URL || 'http://localhost:3000';
    const callbackUrl = `${baseUrl}/api/integrations/google-calendar/callback`;

    // Create signed state to prevent CSRF and preserve context
    const stateData = {
      userId,
      returnUrl,
      timestamp: Date.now(),
    };

    const statePayload = JSON.stringify(stateData);
    const signature = crypto
      .createHmac('sha256', process.env.OAUTH_STATE_SECRET!)
      .update(statePayload)
      .digest('hex');

    const stateWithSignature = JSON.stringify({ data: stateData, sig: signature });
    const stateParam = Buffer.from(stateWithSignature).toString('base64');

    // Generate OAuth URL with calendar scope
    // Using include_granted_scopes for incremental authorization
    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID!,
      redirect_uri: callbackUrl,
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/calendar',
      access_type: 'offline', // Required for refresh token
      prompt: 'consent', // Force consent to get refresh token
      include_granted_scopes: 'true', // Incremental auth
      state: stateParam,
    });

    // If user has Google account linked, hint to use that account
    if (user.email) {
      params.set('login_hint', user.email);
    }

    const oauthUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

    loggers.auth.info('Google Calendar OAuth initiated', {
      userId,
      clientIP,
    });

    return Response.json({ url: oauthUrl });
  } catch (error) {
    loggers.auth.error('Google Calendar connect error', error as Error);
    return Response.json({ error: 'An unexpected error occurred' }, { status: 500 });
  }
}
