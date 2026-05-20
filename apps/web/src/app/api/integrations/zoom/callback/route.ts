import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { db } from '@pagespace/db/db';
import { zoomConnections } from '@pagespace/db/schema/zoom';
import { isOnPrem } from '@pagespace/lib/deployment-mode';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { encrypt } from '@pagespace/lib/encryption/encryption-utils';
import { secureCompare } from '@pagespace/lib/auth/secure-compare';
import { normalizeZoomReturnPath } from '@/lib/integrations/zoom/return-url';

const STATE_MAX_AGE_MS = 10 * 60 * 1000;

export async function GET(req: Request) {
  if (isOnPrem()) return Response.json({ error: 'Not available' }, { status: 404 });

  const baseUrl = process.env.WEB_APP_URL || process.env.NEXTAUTH_URL || 'http://localhost:3000';

  try {
    if (!process.env.ZOOM_OAUTH_CLIENT_ID || !process.env.ZOOM_OAUTH_CLIENT_SECRET || !process.env.OAUTH_STATE_SECRET) {
      loggers.auth.error('Missing required Zoom OAuth environment variables for callback');
      return NextResponse.redirect(new URL('/settings/integrations/zoom?error=oauth_config', baseUrl));
    }

    const { searchParams } = new URL(req.url);
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const error = searchParams.get('error');

    if (error) {
      const errorParam = error === 'access_denied' ? 'access_denied' : 'oauth_error';
      return NextResponse.redirect(new URL(`/settings/integrations/zoom?error=${errorParam}`, baseUrl));
    }

    if (!code || !state) {
      return NextResponse.redirect(new URL('/settings/integrations/zoom?error=invalid_request', baseUrl));
    }

    // Verify HMAC-signed state
    let stateData: { userId: string; returnUrl: string; timestamp: number };
    try {
      const parsed = JSON.parse(Buffer.from(state, 'base64').toString('utf-8'));
      if (!parsed.data || !parsed.sig) throw new Error('Invalid state structure');

      const expectedSig = crypto
        .createHmac('sha256', process.env.OAUTH_STATE_SECRET!)
        .update(JSON.stringify(parsed.data))
        .digest('hex');

      if (!secureCompare(String(parsed.sig), expectedSig)) {
        loggers.auth.warn('Zoom OAuth state signature mismatch');
        return NextResponse.redirect(new URL('/settings/integrations/zoom?error=invalid_state', baseUrl));
      }

      stateData = parsed.data;

      if (Date.now() - stateData.timestamp > STATE_MAX_AGE_MS) {
        return NextResponse.redirect(new URL('/settings/integrations/zoom?error=state_expired', baseUrl));
      }
    } catch {
      return NextResponse.redirect(new URL('/settings/integrations/zoom?error=invalid_state', baseUrl));
    }

    const { userId, returnUrl } = stateData;
    const callbackUrl = `${baseUrl}/api/integrations/zoom/callback`;

    // Exchange authorization code for tokens (Zoom uses HTTP Basic auth)
    const credentials = Buffer.from(
      `${process.env.ZOOM_OAUTH_CLIENT_ID}:${process.env.ZOOM_OAUTH_CLIENT_SECRET}`
    ).toString('base64');

    const tokenRes = await fetch('https://zoom.us/oauth/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: callbackUrl,
      }),
    });

    if (!tokenRes.ok) {
      loggers.auth.error('Zoom token exchange failed', { status: tokenRes.status });
      return NextResponse.redirect(new URL('/settings/integrations/zoom?error=token_exchange_failed', baseUrl));
    }

    const tokens = await tokenRes.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      token_type: string;
    };

    if (!tokens.access_token) {
      return NextResponse.redirect(new URL('/settings/integrations/zoom?error=missing_tokens', baseUrl));
    }

    // Fetch Zoom user identity for webhook mapping
    const meRes = await fetch('https://api.zoom.us/v2/users/me', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });

    if (!meRes.ok) {
      loggers.auth.error('Zoom /users/me failed', { status: meRes.status });
      return NextResponse.redirect(new URL('/settings/integrations/zoom?error=user_info_failed', baseUrl));
    }

    const me = await meRes.json() as { id: string; account_id: string; email: string };

    if (!me.id || !me.account_id || !me.email) {
      return NextResponse.redirect(new URL('/settings/integrations/zoom?error=user_info_incomplete', baseUrl));
    }

    // ZERO-TRUST: Encrypt tokens before storage
    const encryptedAccessToken = await encrypt(tokens.access_token);
    const encryptedRefreshToken = tokens.refresh_token ? await encrypt(tokens.refresh_token) : null;
    const tokenExpiresAt = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000)
      : null;

    await db
      .insert(zoomConnections)
      .values({
        userId,
        accessToken: encryptedAccessToken,
        refreshToken: encryptedRefreshToken ?? undefined,
        tokenExpiresAt: tokenExpiresAt ?? undefined,
        zoomUserId: me.id,
        zoomAccountId: me.account_id,
        zoomEmail: me.email,
        status: 'active',
      })
      .onConflictDoUpdate({
        target: zoomConnections.userId,
        set: {
          accessToken: encryptedAccessToken,
          refreshToken: encryptedRefreshToken ?? undefined,
          tokenExpiresAt: tokenExpiresAt ?? undefined,
          zoomUserId: me.id,
          zoomAccountId: me.account_id,
          zoomEmail: me.email,
          status: 'active',
          updatedAt: new Date(),
        },
      });

    loggers.auth.info('Zoom connected successfully', { userId });
    auditRequest(req, { eventType: 'auth.token.created', userId, details: { tokenType: 'zoom' } });
    auditRequest(req, { eventType: 'data.write', userId, resourceType: 'zoom_connection', resourceId: 'self', details: { operation: 'oauth_complete' } });

    const safePath = normalizeZoomReturnPath(returnUrl);
    const redirectUrl = new URL(safePath, baseUrl);
    redirectUrl.searchParams.set('connected', 'true');
    return NextResponse.redirect(redirectUrl);
  } catch (error) {
    loggers.auth.error('Zoom OAuth callback error', error as Error);
    return NextResponse.redirect(new URL('/settings/integrations/zoom?error=unexpected', baseUrl));
  }
}
