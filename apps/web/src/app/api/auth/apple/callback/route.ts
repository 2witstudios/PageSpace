import { z } from 'zod/v4';
import { sessionService, generateCSRFToken, createExchangeCode, SESSION_DURATION_MS, verifyAppleIdToken } from '@pagespace/lib/auth';
import {
  checkDistributedRateLimit,
  resetDistributedRateLimit,
  DISTRIBUTED_RATE_LIMITS,
} from '@pagespace/lib/security';
import { createId } from '@paralleldrive/cuid2';
import { loggers, logAuthEvent, securityAudit, validateOrCreateDeviceToken } from '@pagespace/lib/server';
import { revokeSessionsForLogin, createWebDeviceToken } from '@/lib/auth';
import { trackAuthEvent } from '@pagespace/lib/activity-tracker';
import { NextResponse } from 'next/server';
import { provisionGettingStartedDriveIfNeeded } from '@/lib/onboarding/getting-started-drive';
import { getClientIP, isSafeReturnUrl } from '@/lib/auth';
import { verifyOAuthState } from '@/lib/auth/oauth-state';
import { appendSessionCookie, createDeviceTokenHandoffCookie } from '@/lib/auth/cookie-config';
import { authRepository } from '@/lib/repositories/auth-repository';

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
    const userJson = formData.get('user') as string | null;
    const baseUrl = process.env.NEXTAUTH_URL || process.env.WEB_APP_URL || new URL(req.url).origin;

    // Verify state HMAC upfront — this is the server-side security gate
    const stateResult = state ? verifyOAuthState(state) : null;
    const verifiedState = stateResult?.status === 'valid' ? stateResult.data : null;

    // Single rejection guard: id_token + HMAC-verified state required
    // `error` is never a branch condition — only read as a UX hint inside
    if (!idToken || !verifiedState) {
      const errorHint = formData.get('error') as string | null;
      loggers.auth.warn('Apple OAuth callback rejected', {
        hasIdToken: !!idToken,
        hasState: !!state,
        stateStatus: stateResult?.status ?? 'missing',
        errorHint: errorHint ? String(errorHint).slice(0, 100) : 'none',
      });
      const errorType = errorHint === 'user_cancelled_authorize' ? 'access_denied' : 'oauth_error';
      securityAudit.logAuthFailure('unknown', getClientIP(req), 'apple_oauth_rejected').catch((error) => {
        loggers.security.warn('[AppleCallback] audit logAuthFailure failed', { error: error instanceof Error ? error.message : String(error) });
      });

      if (verifiedState?.platform === 'desktop') {
        return NextResponse.redirect(`pagespace://auth-error?error=${errorType}`);
      }
      return NextResponse.redirect(new URL(`/auth/signin?error=${encodeURIComponent(errorType)}`, baseUrl));
    }

    // Past this point: id_token present + HMAC-verified state
    let returnUrl = isSafeReturnUrl(verifiedState.returnUrl)
      ? (verifiedState.returnUrl || '/dashboard')
      : '/dashboard';
    const platform = verifiedState.platform || 'web';
    const deviceId = verifiedState.deviceId;
    const deviceName = verifiedState.deviceName;

    const clientIP = getClientIP(req);

    // Rate limiting
    const ipRateLimit = await checkDistributedRateLimit(
      `oauth:callback:ip:${clientIP}`,
      DISTRIBUTED_RATE_LIMITS.LOGIN
    );
    if (!ipRateLimit.allowed) {
      return NextResponse.redirect(new URL('/auth/signin?error=rate_limit', baseUrl));
    }

    // Verify the ID token with Apple
    const verificationResult = await verifyAppleIdToken(idToken);

    if (!verificationResult.success || !verificationResult.userInfo) {
      loggers.auth.error('Apple ID token verification failed', {
        error: verificationResult.error,
      });
      return NextResponse.redirect(new URL('/auth/signin?error=oauth_error', baseUrl));
    }

    const { providerId: appleId, email, emailVerified } = verificationResult.userInfo;

    if (!email) {
      loggers.auth.error('Missing required email from Apple');
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
        // SECURITY: Never log raw userJson - it contains PII (name, email)
        loggers.auth.warn('Failed to parse Apple user JSON', {
          userJsonLength: userJson?.length,
          parseError: true,
        });
      }
    }

    // Build user name from Apple-provided info
    const name = [givenName, familyName].filter(Boolean).join(' ') || undefined;
    const userName = name || email.split('@')[0] || 'User';

    // Find or create user
    let user = await authRepository.findUserByAppleIdOrEmail(appleId, email);

    if (user) {
      // Update existing user if needed
      if (!user.appleId || !user.name) {
        loggers.auth.info('Updating existing user via Apple OAuth', { email });
        await authRepository.updateUser(user.id, {
          appleId: appleId || user.appleId,
          provider: 'apple',
          name: user.name || userName,
          emailVerified: emailVerified ? new Date() : user.emailVerified,
        });

        user = await authRepository.findUserById(user.id) || user;
        loggers.auth.info('User updated via Apple OAuth', { userId: user.id, name: user.name });
      }
    } else {
      // Create new user
      loggers.auth.info('Creating new user via Apple OAuth', { email });
      user = await authRepository.createUser({
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
      });
      loggers.auth.info('New user created via Apple OAuth', { userId: user.id, name: user.name });
    }

    // Provision getting started drive for new users
    let isNewlyProvisioned = false;
    try {
      const provisionedDrive = await provisionGettingStartedDriveIfNeeded(user.id);
      if (provisionedDrive.created) {
        isNewlyProvisioned = true;
        returnUrl = `/dashboard/${provisionedDrive.driveId}`;
      }
    } catch (provisionError) {
      loggers.auth.error('Failed to provision Getting Started drive', provisionError as Error, {
        userId: user.id,
        provider: 'apple',
      });
    }

    await revokeSessionsForLogin(user.id, deviceId, 'new_login', 'Apple OAuth');

    // Create new session
    const sessionToken = await sessionService.createSession({
      userId: user.id,
      type: 'user',
      scopes: ['*'],
      expiresInMs: SESSION_DURATION_MS,
      deviceId,
      createdByIp: clientIP !== 'unknown' ? clientIP : undefined,
    });

    // Validate session to get claims for CSRF
    const sessionClaims = await sessionService.validateSession(sessionToken);
    if (!sessionClaims) {
      loggers.auth.error('Failed to validate newly created session', { userId: user.id });
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
    securityAudit.logAuthSuccess(user.id, sessionClaims.sessionId, clientIP, req.headers.get('user-agent') || 'unknown').catch((error) => {
      loggers.security.warn('[AppleCallback] audit logAuthSuccess failed', { error: error instanceof Error ? error.message : String(error), userId: user.id });
    });

    // DESKTOP PLATFORM: Redirect with tokens encoded via exchange code
    if (platform === 'desktop') {
      if (!deviceId) {
        loggers.auth.error('Desktop OAuth callback missing deviceId', {
          userId: user.id,
          email: user.email,
        });
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
      if (isNewlyProvisioned) {
        deepLinkUrl.searchParams.set('isNewUser', 'true');
      }

      loggers.auth.info('Desktop Apple OAuth deep link redirect', {
        userId: user.id,
        provider: 'apple',
        hasNewUserFlag: isNewlyProvisioned,
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
      if (isNewlyProvisioned) {
        deepLinkUrl.searchParams.set('isNewUser', 'true');
      }

      loggers.auth.info('iOS Apple OAuth deep link redirect', {
        userId: user.id,
        provider: 'apple',
        hasNewUserFlag: isNewlyProvisioned,
      });

      return NextResponse.redirect(deepLinkUrl.toString());
    }

    let webDeviceTokenValue: string | undefined;
    if (deviceId) {
      try {
        webDeviceTokenValue = await createWebDeviceToken({
          userId: user.id, deviceId, tokenVersion: user.tokenVersion,
          deviceName: deviceName || req.headers.get('user-agent') || 'Web Browser',
          userAgent: req.headers.get('user-agent') || undefined,
          ipAddress: clientIP !== 'unknown' ? clientIP : undefined,
        });
      } catch (error) {
        loggers.auth.warn('Failed to create device token', {
          userId: user.id, error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const redirectUrl = new URL(returnUrl, baseUrl);
    redirectUrl.searchParams.set('auth', 'success');

    const headers = new Headers();
    appendSessionCookie(headers, sessionToken);
    if (webDeviceTokenValue) {
      headers.append('Set-Cookie', createDeviceTokenHandoffCookie(webDeviceTokenValue));
    }

    return NextResponse.redirect(redirectUrl, { headers });

  } catch (error) {
    loggers.auth.error('Apple OAuth callback error', error as Error);
    securityAudit.logAuthFailure('unknown', getClientIP(req), 'apple_oauth_error').catch((auditError) => {
      loggers.security.warn('[AppleCallback] audit logAuthFailure failed', { error: auditError instanceof Error ? auditError.message : String(auditError) });
    });
    const errorRedirectBase = process.env.NEXTAUTH_URL || process.env.WEB_APP_URL || req.url;
    return NextResponse.redirect(new URL('/auth/signin?error=oauth_error', errorRedirectBase));
  }
}
