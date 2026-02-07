import { NextResponse } from 'next/server';
import { db, googleCalendarConnections } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { encrypt } from '@pagespace/lib';
import { OAuth2Client } from 'google-auth-library';
import crypto from 'crypto';
import {
  GOOGLE_CALENDAR_DEFAULT_RETURN_PATH,
  normalizeGoogleCalendarReturnPath,
} from '@/lib/integrations/google-calendar/return-url';

// State expiration: 10 minutes
const STATE_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * Handles Google Calendar OAuth callback.
 * Exchanges authorization code for tokens and stores encrypted credentials.
 */
export async function GET(req: Request) {
  const baseUrl = process.env.WEB_APP_URL || process.env.NEXTAUTH_URL || 'http://localhost:3000';

  try {
    // Validate required OAuth environment variables
    if (
      !process.env.GOOGLE_OAUTH_CLIENT_ID ||
      !process.env.GOOGLE_OAUTH_CLIENT_SECRET ||
      !process.env.OAUTH_STATE_SECRET
    ) {
      loggers.auth.error('Missing required OAuth environment variables for Calendar callback');
      return NextResponse.redirect(new URL('/settings?error=oauth_config', baseUrl));
    }

    const { searchParams } = new URL(req.url);
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const error = searchParams.get('error');

    // Handle OAuth errors (user denied, etc.)
    if (error) {
      loggers.auth.warn('Google Calendar OAuth error', { error });
      const errorParam = error === 'access_denied' ? 'access_denied' : 'oauth_error';
      return NextResponse.redirect(
        new URL(`/settings/integrations/google-calendar?error=${errorParam}`, baseUrl)
      );
    }

    // Validate required parameters
    if (!code || !state) {
      loggers.auth.warn('Missing code or state in Calendar OAuth callback');
      return NextResponse.redirect(
        new URL('/settings/integrations/google-calendar?error=invalid_request', baseUrl)
      );
    }

    // Validate and decode state parameter
    let stateData: { userId: string; returnUrl: string; timestamp: number };
    try {
      const stateWithSignature = JSON.parse(Buffer.from(state, 'base64').toString('utf-8'));

      if (!stateWithSignature.data || !stateWithSignature.sig) {
        throw new Error('Invalid state structure');
      }

      // Verify signature using timing-safe comparison to prevent timing attacks
      const expectedSignature = crypto
        .createHmac('sha256', process.env.OAUTH_STATE_SECRET!)
        .update(JSON.stringify(stateWithSignature.data))
        .digest('hex');

      const sigBuffer = Buffer.from(stateWithSignature.sig, 'utf-8');
      const expectedBuffer = Buffer.from(expectedSignature, 'utf-8');
      if (sigBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
        loggers.auth.warn('Google Calendar OAuth state signature mismatch');
        return NextResponse.redirect(
          new URL('/settings/integrations/google-calendar?error=invalid_state', baseUrl)
        );
      }

      stateData = stateWithSignature.data;

      // Check state expiration
      if (Date.now() - stateData.timestamp > STATE_MAX_AGE_MS) {
        loggers.auth.warn('Google Calendar OAuth state expired', { userId: stateData.userId });
        return NextResponse.redirect(
          new URL('/settings/integrations/google-calendar?error=state_expired', baseUrl)
        );
      }
    } catch {
      loggers.auth.warn('Failed to parse Google Calendar OAuth state');
      return NextResponse.redirect(
        new URL('/settings/integrations/google-calendar?error=invalid_state', baseUrl)
      );
    }

    const { userId, returnUrl } = stateData;

    // Build callback URL (must match what was used in connect)
    const callbackUrl = `${baseUrl}/api/integrations/google-calendar/callback`;

    // Exchange authorization code for tokens
    const client = new OAuth2Client(
      process.env.GOOGLE_OAUTH_CLIENT_ID,
      process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      callbackUrl
    );

    const { tokens } = await client.getToken(code);

    if (!tokens.access_token || !tokens.refresh_token) {
      loggers.auth.error('Missing tokens from Google Calendar OAuth', {
        hasAccessToken: !!tokens.access_token,
        hasRefreshToken: !!tokens.refresh_token,
      });
      return NextResponse.redirect(
        new URL('/settings/integrations/google-calendar?error=missing_tokens', baseUrl)
      );
    }

    // Get user info from access token to verify identity
    client.setCredentials(tokens);
    const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });

    if (!userInfoResponse.ok) {
      loggers.auth.error('Failed to fetch Google user info', {
        status: userInfoResponse.status,
      });
      return NextResponse.redirect(
        new URL('/settings/integrations/google-calendar?error=user_info_failed', baseUrl)
      );
    }

    const userInfo = await userInfoResponse.json();
    const googleEmail = userInfo.email;
    const googleAccountId = userInfo.id;
    const emailVerified = userInfo.verified_email;

    if (!googleEmail || !googleAccountId) {
      loggers.auth.error('Missing email or ID from Google user info');
      return NextResponse.redirect(
        new URL('/settings/integrations/google-calendar?error=user_info_incomplete', baseUrl)
      );
    }

    if (!emailVerified) {
      loggers.auth.warn('Google account email is not verified', { googleEmail });
      return NextResponse.redirect(
        new URL('/settings/integrations/google-calendar?error=email_not_verified', baseUrl)
      );
    }

    // ZERO-TRUST: Encrypt tokens before storage
    const encryptedAccessToken = await encrypt(tokens.access_token);
    const encryptedRefreshToken = await encrypt(tokens.refresh_token);

    // Calculate token expiration
    const tokenExpiresAt = tokens.expiry_date
      ? new Date(tokens.expiry_date)
      : new Date(Date.now() + 3600 * 1000); // Default 1 hour if not provided

    // Upsert connection (one per user)
    await db
      .insert(googleCalendarConnections)
      .values({
        userId,
        accessToken: encryptedAccessToken,
        refreshToken: encryptedRefreshToken,
        tokenExpiresAt,
        googleEmail,
        googleAccountId,
        status: 'active',
        statusMessage: null,
        selectedCalendars: [googleEmail], // Use actual email, not 'primary' alias
        syncFrequencyMinutes: 15,
        markAsReadOnly: false, // Two-way sync enabled by default
        lastSyncAt: null,
        lastSyncError: null,
        syncCursor: null,
      })
      .onConflictDoUpdate({
        target: googleCalendarConnections.userId,
        set: {
          accessToken: encryptedAccessToken,
          refreshToken: encryptedRefreshToken,
          tokenExpiresAt,
          googleEmail,
          googleAccountId,
          status: 'active',
          statusMessage: null,
          updatedAt: new Date(),
        },
      });

    loggers.auth.info('Google Calendar connected successfully', {
      userId,
    });

    // Redirect back to settings with success
    const redirectPath = normalizeGoogleCalendarReturnPath(
      returnUrl || GOOGLE_CALENDAR_DEFAULT_RETURN_PATH
    );
    const redirectUrl = new URL(redirectPath, baseUrl);
    redirectUrl.searchParams.set('connected', 'true');

    return NextResponse.redirect(redirectUrl);
  } catch (error) {
    loggers.auth.error('Google Calendar OAuth callback error', error as Error);
    return NextResponse.redirect(
      new URL('/settings/integrations/google-calendar?error=unexpected', baseUrl)
    );
  }
}
