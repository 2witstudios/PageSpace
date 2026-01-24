import { users, db, eq, or } from '@pagespace/db';
import { z } from 'zod/v4';
import { sessionService, generateCSRFToken } from '@pagespace/lib/auth';
import {
  checkDistributedRateLimit,
  resetDistributedRateLimit,
  DISTRIBUTED_RATE_LIMITS,
} from '@pagespace/lib/security';
import { createId } from '@paralleldrive/cuid2';
import { loggers, logAuthEvent, validateOrCreateDeviceToken } from '@pagespace/lib/server';
import { trackAuthEvent } from '@pagespace/lib/activity-tracker';
import { OAuth2Client } from 'google-auth-library';
import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { provisionGettingStartedDriveIfNeeded } from '@/lib/onboarding/getting-started-drive';
import { getClientIP } from '@/lib/auth';
import { appendSessionCookie } from '@/lib/auth/cookie-config';

const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function isSafeReturnUrl(url: string | undefined): boolean {
  if (!url) return true;
  if (!url.startsWith('/')) return false;
  if (url.startsWith('//') || url.startsWith('/\\')) return false;
  if (/[a-z]+:/i.test(url)) return false;
  try {
    const decoded = decodeURIComponent(url);
    if (decoded.startsWith('//') || decoded.startsWith('/\\')) return false;
    if (/[a-z]+:/i.test(decoded)) return false;
  } catch {
    return false;
  }
  return true;
}

const googleCallbackSchema = z.object({
  code: z.string().min(1, 'Authorization code is required'),
  state: z.string().nullish().optional(),
});

const client = new OAuth2Client(
  process.env.GOOGLE_OAUTH_CLIENT_ID,
  process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  process.env.GOOGLE_OAUTH_REDIRECT_URI
);

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const error = searchParams.get('error');

    if (error) {
      loggers.auth.warn('OAuth error', { error });
      let errorParam = 'oauth_error';
      if (error === 'access_denied') {
        errorParam = 'access_denied';
      }
      const baseUrl = process.env.NEXTAUTH_URL || process.env.WEB_APP_URL || req.url;
      return NextResponse.redirect(new URL(`/auth/signin?error=${errorParam}`, baseUrl));
    }

    const validation = googleCallbackSchema.safeParse({ code, state });
    if (!validation.success) {
      loggers.auth.warn('Invalid OAuth callback parameters', validation.error);
      const baseUrl = process.env.NEXTAUTH_URL || process.env.WEB_APP_URL || req.url;
      return NextResponse.redirect(new URL('/auth/signin?error=invalid_request', baseUrl));
    }

    const { code: authCode, state: stateParam } = validation.data;

    let returnUrl = '/dashboard';
    let platform = 'web';
    let deviceId: string | undefined;
    let deviceName: string | undefined;

    if (stateParam) {
      try {
        const stateWithSignature = JSON.parse(
          Buffer.from(stateParam, 'base64').toString('utf-8')
        );

        if (stateWithSignature.data && stateWithSignature.sig) {
          const { data, sig } = stateWithSignature;
          const expectedSignature = crypto
            .createHmac('sha256', process.env.OAUTH_STATE_SECRET!)
            .update(JSON.stringify(data))
            .digest('hex');

          if (sig !== expectedSignature) {
            loggers.auth.warn('OAuth state signature mismatch', { stateParam });
            const baseUrl = process.env.NEXTAUTH_URL || process.env.WEB_APP_URL || req.url;
            return NextResponse.redirect(new URL('/auth/signin?error=invalid_request', baseUrl));
          }

          returnUrl = data.returnUrl || '/dashboard';
          platform = data.platform || 'web';
          deviceId = data.deviceId;
          deviceName = data.deviceName;
        } else {
          returnUrl = stateWithSignature.returnUrl || '/dashboard';
        }
      } catch {
        returnUrl = stateParam;
      }
    }

    if (!isSafeReturnUrl(returnUrl)) {
      loggers.auth.warn('Unsafe returnUrl in OAuth callback - falling back to dashboard', {
        returnUrl,
        hasState: !!stateParam,
      });
      returnUrl = '/dashboard';
    }

    const clientIP = getClientIP(req);

    const ipRateLimit = await checkDistributedRateLimit(
      `oauth:callback:ip:${clientIP}`,
      DISTRIBUTED_RATE_LIMITS.LOGIN
    );
    if (!ipRateLimit.allowed) {
      const baseUrl = process.env.NEXTAUTH_URL || process.env.WEB_APP_URL || req.url;
      return NextResponse.redirect(new URL('/auth/signin?error=rate_limit', baseUrl));
    }

    const { tokens } = await client.getToken(authCode);

    if (!tokens.id_token) {
      loggers.auth.error('No ID token received from Google');
      const baseUrl = process.env.NEXTAUTH_URL || process.env.WEB_APP_URL || req.url;
      return NextResponse.redirect(new URL('/auth/signin?error=oauth_error', baseUrl));
    }

    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token,
      audience: process.env.GOOGLE_OAUTH_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    if (!payload) {
      loggers.auth.error('Invalid Google ID token payload');
      const baseUrl = process.env.NEXTAUTH_URL || process.env.WEB_APP_URL || req.url;
      return NextResponse.redirect(new URL('/auth/signin?error=oauth_error', baseUrl));
    }

    const { sub: googleId, email, name, picture, email_verified } = payload;

    if (!email) {
      loggers.auth.error('Missing required email from Google');
      const baseUrl = process.env.NEXTAUTH_URL || process.env.WEB_APP_URL || req.url;
      return NextResponse.redirect(new URL('/auth/signin?error=oauth_error', baseUrl));
    }

    const userName = name || email.split('@')[0] || 'User';

    let user = await db.query.users.findFirst({
      where: or(
        eq(users.googleId, googleId),
        eq(users.email, email)
      ),
    });

    if (user) {
      if (!user.googleId || !user.name || user.image !== picture) {
        loggers.auth.info('Updating existing user via Google OAuth', { email });
        await db.update(users)
          .set({
            googleId: googleId || user.googleId,
            provider: user.password ? 'both' : 'google',
            name: user.name || userName,
            image: picture || user.image,
            emailVerified: email_verified ? new Date() : user.emailVerified,
          })
          .where(eq(users.id, user.id));

        user = await db.query.users.findFirst({
          where: eq(users.id, user.id),
        }) || user;
        loggers.auth.info('User updated via Google OAuth', { userId: user.id, name: user.name });
      }
    } else {
      loggers.auth.info('Creating new user via Google OAuth', { email });
      const [newUser] = await db.insert(users).values({
        id: createId(),
        name: userName,
        email,
        emailVerified: email_verified ? new Date() : null,
        image: picture || null,
        googleId,
        provider: 'google',
        tokenVersion: 0,
        role: 'user',
        storageUsedBytes: 0,
        subscriptionTier: 'free',
      }).returning();

      user = newUser;
      loggers.auth.info('New user created via Google OAuth', { userId: user.id, name: user.name });
    }

    let provisionedDrive: { driveId: string } | null = null;
    try {
      provisionedDrive = await provisionGettingStartedDriveIfNeeded(user.id);
      if (provisionedDrive) {
        returnUrl = `/dashboard/${provisionedDrive.driveId}`;
      }
    } catch (error) {
      loggers.auth.error('Failed to provision Getting Started drive', error as Error, {
        userId: user.id,
        provider: 'google',
      });
    }

    // SESSION FIXATION PREVENTION: Revoke all existing sessions before creating new one
    const revokedCount = await sessionService.revokeAllUserSessions(user.id, 'new_login');
    if (revokedCount > 0) {
      loggers.auth.info('Revoked existing sessions on Google OAuth login', { userId: user.id, count: revokedCount });
    }

    // Create new session
    const sessionToken = await sessionService.createSession({
      userId: user.id,
      type: 'user',
      scopes: ['*'],
      expiresInMs: SESSION_DURATION_MS,
      createdByIp: clientIP !== 'unknown' ? clientIP : undefined,
    });

    // Validate session to get claims for CSRF
    const sessionClaims = await sessionService.validateSession(sessionToken);
    if (!sessionClaims) {
      loggers.auth.error('Failed to validate newly created session', { userId: user.id });
      const baseUrl = process.env.NEXTAUTH_URL || process.env.WEB_APP_URL || req.url;
      return NextResponse.redirect(new URL('/auth/signin?error=oauth_error', baseUrl));
    }

    const csrfToken = generateCSRFToken(sessionClaims.sessionId);

    try {
      await resetDistributedRateLimit(`oauth:callback:ip:${clientIP}`);
    } catch (error) {
      loggers.auth.warn('Rate limit reset failed after successful OAuth callback', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    logAuthEvent('login', user.id, email, clientIP, 'Google OAuth');
    trackAuthEvent(user.id, 'login', {
      email,
      ip: clientIP,
      provider: 'google',
      userAgent: req.headers.get('user-agent')
    });

    // DESKTOP PLATFORM: Redirect with tokens encoded in URL
    // OAuth callbacks happen via browser redirect from Google, so we can't return JSON
    // The desktop app (Electron) intercepts the redirect URL and extracts the tokens
    if (platform === 'desktop') {
      if (!deviceId) {
        loggers.auth.error('Desktop OAuth callback missing deviceId', {
          userId: user.id,
          email: user.email,
        });
        const baseUrl = process.env.NEXTAUTH_URL || process.env.WEB_APP_URL || req.url;
        return NextResponse.redirect(new URL('/auth/signin?error=oauth_error', baseUrl));
      }

      // Generate device token (now opaque ps_dev_* token)
      const { deviceToken: deviceTokenValue } = await validateOrCreateDeviceToken({
        providedDeviceToken: undefined,
        userId: user.id,
        deviceId: deviceId,
        platform: 'desktop',
        tokenVersion: user.tokenVersion,
        deviceName: deviceName || req.headers.get('user-agent') || 'Desktop App',
        userAgent: req.headers.get('user-agent') || undefined,
        ipAddress: clientIP !== 'unknown' ? clientIP : undefined,
      });

      await resetDistributedRateLimit(`oauth:callback:ip:${clientIP}`).catch(() => {});

      trackAuthEvent(user.id, 'login', {
        email,
        ip: clientIP,
        provider: 'google-oauth',
        platform: 'desktop',
        userAgent: req.headers.get('user-agent'),
      });

      // Encode tokens as base64 JSON for URL transport
      const tokensPayload = {
        sessionToken,
        csrfToken,
        deviceToken: deviceTokenValue,
      };
      const tokensBase64 = Buffer.from(JSON.stringify(tokensPayload)).toString('base64url');

      // Redirect to dashboard with tokens in URL
      // Desktop app (Electron) intercepts this and extracts tokens
      const baseUrl = process.env.NEXTAUTH_URL || process.env.WEB_APP_URL || req.url;
      const redirectUrl = new URL(returnUrl, baseUrl);
      redirectUrl.searchParams.set('desktop', 'true');
      redirectUrl.searchParams.set('tokens', tokensBase64);
      redirectUrl.searchParams.set('auth', 'success');
      if (provisionedDrive) {
        redirectUrl.searchParams.set('isNewUser', 'true');
      }

      loggers.auth.info('Desktop OAuth redirect', {
        userId: user.id,
        redirectUrl: redirectUrl.pathname,
      });

      return NextResponse.redirect(redirectUrl);
    }

    // WEB PLATFORM: Original redirect flow (UNCHANGED)
    const baseUrl = process.env.NEXTAUTH_URL || process.env.WEB_APP_URL || req.url;
    const redirectUrl = new URL(returnUrl, baseUrl);
    redirectUrl.searchParams.set('auth', 'success');
    redirectUrl.searchParams.set('csrfToken', csrfToken);

    const headers = new Headers();
    appendSessionCookie(headers, sessionToken);

    return NextResponse.redirect(redirectUrl, { headers });

  } catch (error) {
    loggers.auth.error('Google OAuth callback error', error as Error);
    const baseUrl = process.env.NEXTAUTH_URL || process.env.WEB_APP_URL || req.url;
    return NextResponse.redirect(new URL('/auth/signin?error=oauth_error', baseUrl));
  }
}
