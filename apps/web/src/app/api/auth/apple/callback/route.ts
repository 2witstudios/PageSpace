import { users, db, eq, or } from '@pagespace/db';
import { z } from 'zod/v4';
import { sessionService, generateCSRFToken, createExchangeCode, SESSION_DURATION_MS, verifyAppleIdToken } from '@pagespace/lib/auth';
import {
  checkDistributedRateLimit,
  resetDistributedRateLimit,
  DISTRIBUTED_RATE_LIMITS,
} from '@pagespace/lib/security';
import { createId } from '@paralleldrive/cuid2';
import { loggers, logAuthEvent, validateOrCreateDeviceToken } from '@pagespace/lib/server';
import { trackAuthEvent } from '@pagespace/lib/activity-tracker';
import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { provisionGettingStartedDriveIfNeeded } from '@/lib/onboarding/getting-started-drive';
import { getClientIP, isSafeReturnUrl } from '@/lib/auth';
import { appendSessionCookie } from '@/lib/auth/cookie-config';

// Apple sends name info as JSON in the 'user' field (only on first authorization)
const appleUserSchema = z.object({
  name: z.object({
    firstName: z.string().optional(),
    lastName: z.string().optional(),
  }).optional(),
  email: z.string().optional(),
}).optional();

/**
 * Apple OAuth callback endpoint.
 * Apple uses response_mode=form_post, so this receives a POST request.
 */
export async function POST(req: Request) {
  try {
    // Parse form data (Apple uses application/x-www-form-urlencoded)
    // Note: Apple sends both 'code' and 'id_token' with response_type=code id_token
    // We use id_token directly for verification (no token exchange needed)
    const formData = await req.formData();
    const idToken = formData.get('id_token') as string | null;
    const state = formData.get('state') as string | null;
    const error = formData.get('error') as string | null;
    const userJson = formData.get('user') as string | null;

    // Handle errors from Apple
    if (error) {
      loggers.auth.warn('Apple OAuth error', { error: String(error).slice(0, 100) });
      let errorParam = 'oauth_error';
      if (error === 'user_cancelled_authorize') {
        errorParam = 'access_denied';
      }
      const baseUrl = process.env.NEXTAUTH_URL || process.env.WEB_APP_URL || new URL(req.url).origin;
      return NextResponse.redirect(new URL(`/auth/signin?error=${encodeURIComponent(errorParam)}`, baseUrl));
    }

    // Validate required fields
    if (!idToken) {
      loggers.auth.warn('Apple OAuth callback missing id_token');
      const baseUrl = process.env.NEXTAUTH_URL || process.env.WEB_APP_URL || new URL(req.url).origin;
      return NextResponse.redirect(new URL('/auth/signin?error=invalid_request', baseUrl));
    }

    // Parse state parameter
    let returnUrl = '/dashboard';
    let platform = 'web';
    let deviceId: string | undefined;
    let deviceName: string | undefined;

    if (state) {
      try {
        const stateWithSignature = JSON.parse(
          Buffer.from(state, 'base64').toString('utf-8')
        );

        if (stateWithSignature.data && stateWithSignature.sig) {
          const { data, sig } = stateWithSignature;
          const expectedSignature = crypto
            .createHmac('sha256', process.env.OAUTH_STATE_SECRET!)
            .update(JSON.stringify(data))
            .digest('hex');

          if (sig !== expectedSignature) {
            loggers.auth.warn('Apple OAuth state signature mismatch', { state });
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
        returnUrl = state;
      }
    }

    if (!isSafeReturnUrl(returnUrl)) {
      loggers.auth.warn('Unsafe returnUrl in Apple OAuth callback - falling back to dashboard', {
        returnUrl,
        hasState: !!state,
      });
      returnUrl = '/dashboard';
    }

    const clientIP = getClientIP(req);

    // Rate limiting
    const ipRateLimit = await checkDistributedRateLimit(
      `oauth:callback:ip:${clientIP}`,
      DISTRIBUTED_RATE_LIMITS.LOGIN
    );
    if (!ipRateLimit.allowed) {
      const baseUrl = process.env.NEXTAUTH_URL || process.env.WEB_APP_URL || req.url;
      return NextResponse.redirect(new URL('/auth/signin?error=rate_limit', baseUrl));
    }

    // Verify the ID token with Apple
    const verificationResult = await verifyAppleIdToken(idToken);

    if (!verificationResult.success || !verificationResult.userInfo) {
      loggers.auth.error('Apple ID token verification failed', {
        error: verificationResult.error,
      });
      const baseUrl = process.env.NEXTAUTH_URL || process.env.WEB_APP_URL || req.url;
      return NextResponse.redirect(new URL('/auth/signin?error=oauth_error', baseUrl));
    }

    const { providerId: appleId, email, emailVerified } = verificationResult.userInfo;

    if (!email) {
      loggers.auth.error('Missing required email from Apple');
      const baseUrl = process.env.NEXTAUTH_URL || process.env.WEB_APP_URL || req.url;
      return NextResponse.redirect(new URL('/auth/signin?error=oauth_error', baseUrl));
    }

    // Parse user info (Apple only sends this on first authorization)
    let givenName: string | undefined;
    let familyName: string | undefined;
    if (userJson) {
      try {
        const userData = JSON.parse(userJson);
        const parsed = appleUserSchema.safeParse(userData);
        if (parsed.success && parsed.data?.name) {
          givenName = parsed.data.name.firstName;
          familyName = parsed.data.name.lastName;
        }
      } catch {
        loggers.auth.warn('Failed to parse Apple user JSON', { userJson });
      }
    }

    // Build user name from Apple-provided info
    const name = [givenName, familyName].filter(Boolean).join(' ') || undefined;
    const userName = name || email.split('@')[0] || 'User';

    // Find or create user
    let user = await db.query.users.findFirst({
      where: or(
        eq(users.appleId, appleId),
        eq(users.email, email)
      ),
    });

    if (user) {
      // Update existing user if needed
      if (!user.appleId || !user.name) {
        loggers.auth.info('Updating existing user via Apple OAuth', { email });
        await db.update(users)
          .set({
            appleId: appleId || user.appleId,
            provider: user.password ? 'both' : 'apple',
            name: user.name || userName,
            emailVerified: emailVerified ? new Date() : user.emailVerified,
          })
          .where(eq(users.id, user.id));

        user = await db.query.users.findFirst({
          where: eq(users.id, user.id),
        }) || user;
        loggers.auth.info('User updated via Apple OAuth', { userId: user.id, name: user.name });
      }
    } else {
      // Create new user
      loggers.auth.info('Creating new user via Apple OAuth', { email });
      const [newUser] = await db.insert(users).values({
        id: createId(),
        name: userName,
        email,
        emailVerified: emailVerified ? new Date() : null,
        image: null, // Apple doesn't provide profile pictures
        appleId,
        provider: 'apple',
        tokenVersion: 0,
        role: 'user',
        storageUsedBytes: 0,
        subscriptionTier: 'free',
      }).returning();

      user = newUser;
      loggers.auth.info('New user created via Apple OAuth', { userId: user.id, name: user.name });
    }

    // Provision getting started drive for new users
    let provisionedDrive: { driveId: string } | null = null;
    try {
      provisionedDrive = await provisionGettingStartedDriveIfNeeded(user.id);
      if (provisionedDrive) {
        returnUrl = `/dashboard/${provisionedDrive.driveId}`;
      }
    } catch (provisionError) {
      loggers.auth.error('Failed to provision Getting Started drive', provisionError as Error, {
        userId: user.id,
        provider: 'apple',
      });
    }

    // SESSION FIXATION PREVENTION: Revoke all existing sessions before creating new one
    const revokedCount = await sessionService.revokeAllUserSessions(user.id, 'new_login');
    if (revokedCount > 0) {
      loggers.auth.info('Revoked existing sessions on Apple OAuth login', { userId: user.id, count: revokedCount });
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
    } catch (resetError) {
      loggers.auth.warn('Rate limit reset failed after successful Apple OAuth callback', {
        error: resetError instanceof Error ? resetError.message : String(resetError),
      });
    }

    logAuthEvent('login', user.id, email, clientIP, 'Apple OAuth');
    trackAuthEvent(user.id, 'login', {
      email,
      ip: clientIP,
      provider: 'apple',
      userAgent: req.headers.get('user-agent')
    });

    // DESKTOP PLATFORM: Redirect with tokens encoded via exchange code
    if (platform === 'desktop') {
      if (!deviceId) {
        loggers.auth.error('Desktop OAuth callback missing deviceId', {
          userId: user.id,
          email: user.email,
        });
        const baseUrl = process.env.NEXTAUTH_URL || process.env.WEB_APP_URL || req.url;
        return NextResponse.redirect(new URL('/auth/signin?error=oauth_error', baseUrl));
      }

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
        provider: 'apple-oauth',
        platform: 'desktop',
        userAgent: req.headers.get('user-agent'),
      });

      const exchangeCode = await createExchangeCode({
        sessionToken,
        csrfToken,
        deviceToken: deviceTokenValue,
        provider: 'apple',
        userId: user.id,
        createdAt: Date.now(),
      });

      const deepLinkUrl = new URL('pagespace://auth-exchange');
      deepLinkUrl.searchParams.set('code', exchangeCode);
      deepLinkUrl.searchParams.set('provider', 'apple');
      if (provisionedDrive) {
        deepLinkUrl.searchParams.set('isNewUser', 'true');
      }

      loggers.auth.info('Desktop Apple OAuth deep link redirect', {
        userId: user.id,
        provider: 'apple',
        hasNewUserFlag: !!provisionedDrive,
      });

      return NextResponse.redirect(deepLinkUrl.toString());
    }

    // iOS PLATFORM: Same as desktop - use secure exchange code flow
    if (platform === 'ios') {
      const iosDeviceId = deviceId || createId();

      const { deviceToken: deviceTokenValue } = await validateOrCreateDeviceToken({
        providedDeviceToken: undefined,
        userId: user.id,
        deviceId: iosDeviceId,
        platform: 'ios',
        tokenVersion: user.tokenVersion,
        deviceName: deviceName || req.headers.get('user-agent') || 'iOS App',
        userAgent: req.headers.get('user-agent') || undefined,
        ipAddress: clientIP !== 'unknown' ? clientIP : undefined,
      });

      await resetDistributedRateLimit(`oauth:callback:ip:${clientIP}`).catch(() => {});

      trackAuthEvent(user.id, 'login', {
        email,
        ip: clientIP,
        provider: 'apple-oauth',
        platform: 'ios',
        userAgent: req.headers.get('user-agent'),
      });

      const exchangeCode = await createExchangeCode({
        sessionToken,
        csrfToken,
        deviceToken: deviceTokenValue,
        provider: 'apple',
        userId: user.id,
        createdAt: Date.now(),
      });

      const deepLinkUrl = new URL('pagespace://auth-exchange');
      deepLinkUrl.searchParams.set('code', exchangeCode);
      deepLinkUrl.searchParams.set('provider', 'apple');
      if (provisionedDrive) {
        deepLinkUrl.searchParams.set('isNewUser', 'true');
      }

      loggers.auth.info('iOS Apple OAuth deep link redirect', {
        userId: user.id,
        provider: 'apple',
        hasNewUserFlag: !!provisionedDrive,
      });

      return NextResponse.redirect(deepLinkUrl.toString());
    }

    // WEB PLATFORM: Redirect with session cookie
    const baseUrl = process.env.NEXTAUTH_URL || process.env.WEB_APP_URL || req.url;
    const redirectUrl = new URL(returnUrl, baseUrl);
    redirectUrl.searchParams.set('auth', 'success');
    redirectUrl.searchParams.set('csrfToken', csrfToken);

    const headers = new Headers();
    appendSessionCookie(headers, sessionToken);

    return NextResponse.redirect(redirectUrl, { headers });

  } catch (error) {
    loggers.auth.error('Apple OAuth callback error', error as Error);
    const baseUrl = process.env.NEXTAUTH_URL || process.env.WEB_APP_URL || req.url;
    return NextResponse.redirect(new URL('/auth/signin?error=oauth_error', baseUrl));
  }
}
