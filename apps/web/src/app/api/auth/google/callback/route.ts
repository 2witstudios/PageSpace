import { sessionService, generateCSRFToken, createExchangeCode, SESSION_DURATION_MS } from '@pagespace/lib/auth';
import {
  checkDistributedRateLimit,
  resetDistributedRateLimit,
  DISTRIBUTED_RATE_LIMITS,
} from '@pagespace/lib/security';
import { createId } from '@paralleldrive/cuid2';
import { loggers, logAuthEvent, securityAudit, validateOrCreateDeviceToken } from '@pagespace/lib/server';
import { revokeSessionsForLogin, createWebDeviceToken } from '@/lib/auth';
import { trackAuthEvent } from '@pagespace/lib/activity-tracker';
import { OAuth2Client } from 'google-auth-library';
import { NextResponse } from 'next/server';
import { provisionGettingStartedDriveIfNeeded } from '@/lib/onboarding/getting-started-drive';
import { getClientIP, isSafeReturnUrl } from '@/lib/auth';
import { verifyOAuthState } from '@/lib/auth/oauth-state';
import { appendSessionCookie, createDeviceTokenHandoffCookie } from '@/lib/auth/cookie-config';
import { resolveGoogleAvatarImage } from '@/lib/auth/google-avatar';
import { consumePKCEVerifier } from '@pagespace/lib/auth';
import { authRepository } from '@/lib/repositories/auth-repository';

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
    const configuredUrl = process.env.NEXTAUTH_URL || process.env.WEB_APP_URL;
    if (!configuredUrl && process.env.NODE_ENV === 'production') {
      loggers.auth.error('NEXTAUTH_URL or WEB_APP_URL must be set in production');
      return new Response('Server misconfiguration', { status: 500 });
    }
    const baseUrl = configuredUrl || new URL(req.url).origin;

    // Verify state HMAC upfront — this is the server-side security gate
    const stateResult = state ? verifyOAuthState(state) : null;
    const verifiedState = stateResult?.status === 'valid' ? stateResult.data : null;

    // Single rejection guard: code + HMAC-verified state required
    // `error` is never a branch condition — only read as a UX hint inside
    if (!code || !verifiedState) {
      const errorHint = searchParams.get('error');
      loggers.auth.warn('OAuth callback rejected', {
        hasCode: !!code,
        hasState: !!state,
        stateStatus: stateResult?.status ?? 'missing',
        errorHint: errorHint ? String(errorHint).slice(0, 100) : 'none',
      });
      const errorType = errorHint === 'access_denied' ? 'access_denied' : 'oauth_error';
      securityAudit.logAuthFailure('unknown', getClientIP(req), 'google_oauth_rejected').catch((error) => {
        loggers.security.warn('[GoogleCallback] audit logAuthFailure failed', { error: error instanceof Error ? error.message : String(error) });
      });

      if (verifiedState?.platform === 'desktop') {
        return NextResponse.redirect(`pagespace://auth-error?error=${errorType}`);
      }
      return NextResponse.redirect(new URL(`/auth/signin?error=${encodeURIComponent(errorType)}`, baseUrl));
    }

    // Past this point: code present + HMAC-verified state
    const authCode = code;
    let returnUrl = isSafeReturnUrl(verifiedState.returnUrl)
      ? (verifiedState.returnUrl || '/dashboard')
      : '/dashboard';
    const platform = verifiedState.platform || 'web';
    const deviceId = verifiedState.deviceId;
    const deviceName = verifiedState.deviceName;

    const clientIP = getClientIP(req);

    const ipRateLimit = await checkDistributedRateLimit(
      `oauth:callback:ip:${clientIP}`,
      DISTRIBUTED_RATE_LIMITS.LOGIN
    );
    if (!ipRateLimit.allowed) {
      return NextResponse.redirect(new URL('/auth/signin?error=rate_limit', baseUrl));
    }

    // Input validation: bound length and reject unexpected characters
    if (authCode.length > 512 || !/^[a-zA-Z0-9/_\-\.]+$/.test(authCode)) {
      loggers.auth.warn('Invalid authorization code format', { codeLength: authCode.length });
      return NextResponse.redirect(new URL('/auth/signin?error=invalid_request', baseUrl));
    }

    // Retrieve PKCE code_verifier (stored during signin, keyed by state)
    // state is guaranteed non-null past the rejection guard
    const codeVerifier = await consumePKCEVerifier(state!);

    const { tokens } = await client.getToken({
      code: authCode,
      ...(codeVerifier && { codeVerifier }),
    });

    if (!tokens.id_token) {
      loggers.auth.error('No ID token received from Google');
      return NextResponse.redirect(new URL('/auth/signin?error=oauth_error', baseUrl));
    }

    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token,
      audience: process.env.GOOGLE_OAUTH_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    if (!payload) {
      loggers.auth.error('Invalid Google ID token payload');
      return NextResponse.redirect(new URL('/auth/signin?error=oauth_error', baseUrl));
    }

    const { sub: googleId, email, name, picture, email_verified } = payload;

    if (!email) {
      loggers.auth.error('Missing required email from Google');
      return NextResponse.redirect(new URL('/auth/signin?error=oauth_error', baseUrl));
    }

    const userName = name || email.split('@')[0] || 'User';

    let user = await authRepository.findUserByGoogleIdOrEmail(googleId!, email);

    if (user) {
      const resolvedImage = await resolveGoogleAvatarImage({
        userId: user.id,
        pictureUrl: picture,
        existingImage: user.image,
      });

      if (
        !user.googleId ||
        !user.name ||
        user.image !== resolvedImage ||
        (email_verified && !user.emailVerified)
      ) {
        loggers.auth.info('Updating existing user via Google OAuth', { email });
        await authRepository.updateUser(user.id, {
          googleId: googleId || user.googleId,
          provider: user.provider === 'email' ? 'google' : user.provider,
          name: user.name || userName,
          image: resolvedImage,
          emailVerified: email_verified ? new Date() : user.emailVerified,
        });

        user = await authRepository.findUserById(user.id) || user;
        loggers.auth.info('User updated via Google OAuth', { userId: user.id, name: user.name });
      }
    } else {
      loggers.auth.info('Creating new user via Google OAuth', { email });
      user = await authRepository.createUser({
        id: createId(),
        name: userName,
        email,
        emailVerified: email_verified ? new Date() : null,
        image: null,
        googleId,
        provider: 'google',
        tokenVersion: 0,
        role: 'user',
        storageUsedBytes: 0,
        subscriptionTier: 'free',
      });

      const resolvedImage = await resolveGoogleAvatarImage({
        userId: user.id,
        pictureUrl: picture,
        existingImage: user.image,
      });

      if (resolvedImage !== (user.image ?? null)) {
        await authRepository.updateUser(user.id, { image: resolvedImage });
        user = { ...user, image: resolvedImage };
      }

      loggers.auth.info('New user created via Google OAuth', { userId: user.id, name: user.name });
    }

    let isNewlyProvisioned = false;
    try {
      const provisionedDrive = await provisionGettingStartedDriveIfNeeded(user.id);
      if (provisionedDrive.created) {
        isNewlyProvisioned = true;
        returnUrl = `/dashboard/${provisionedDrive.driveId}`;
      }
    } catch (error) {
      loggers.auth.error('Failed to provision Getting Started drive', error as Error, {
        userId: user.id,
        provider: 'google',
      });
    }

    await revokeSessionsForLogin(user.id, deviceId, 'new_login', 'Google OAuth');

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
    securityAudit.logAuthSuccess(user.id, sessionClaims.sessionId, clientIP, req.headers.get('user-agent') || 'unknown').catch((error) => {
      loggers.security.warn('[GoogleCallback] audit logAuthSuccess failed', { error: error instanceof Error ? error.message : String(error), userId: user.id });
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

      await resetDistributedRateLimit(`oauth:callback:ip:${clientIP}`).catch(err => {
        loggers.auth.warn('Rate limit reset failed', {
          error: err instanceof Error ? err.message : String(err),
          ip: clientIP,
        });
      });

      trackAuthEvent(user.id, 'login', {
        email,
        ip: clientIP,
        provider: 'google-oauth',
        platform: 'desktop',
        userAgent: req.headers.get('user-agent'),
      });

      // SECURE TOKEN HANDOFF: Generate one-time exchange code
      // Tokens are stored server-side in Redis, only opaque code appears in URL
      // This prevents token leakage in nginx logs, browser history, referer headers
      const exchangeCode = await createExchangeCode({
        sessionToken,
        csrfToken,
        deviceToken: deviceTokenValue,
        provider: 'google',
        userId: user.id,
        createdAt: Date.now(),
      });

      // Build deep link URL with only the opaque exchange code
      // Desktop app intercepts this and exchanges code for tokens via POST
      const deepLinkUrl = new URL('pagespace://auth-exchange');
      deepLinkUrl.searchParams.set('code', exchangeCode);
      deepLinkUrl.searchParams.set('provider', 'google');
      if (isNewlyProvisioned) {
        deepLinkUrl.searchParams.set('isNewUser', 'true');
      }

      loggers.auth.info('Desktop OAuth deep link redirect', {
        userId: user.id,
        provider: 'google',
        hasNewUserFlag: isNewlyProvisioned,
      });

      return NextResponse.redirect(deepLinkUrl.toString());
    }

    // iOS PLATFORM: Same as desktop - use secure exchange code flow
    if (platform === 'ios') {
      // Generate deviceId if not provided
      const iosDeviceId = deviceId || createId();

      // Generate device token
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

      await resetDistributedRateLimit(`oauth:callback:ip:${clientIP}`).catch(err => {
        loggers.auth.warn('Rate limit reset failed', {
          error: err instanceof Error ? err.message : String(err),
          ip: clientIP,
        });
      });

      trackAuthEvent(user.id, 'login', {
        email,
        ip: clientIP,
        provider: 'google-oauth',
        platform: 'ios',
        userAgent: req.headers.get('user-agent'),
      });

      // SECURE TOKEN HANDOFF: Generate one-time exchange code
      // Tokens are stored server-side in Redis, only opaque code appears in URL
      const exchangeCode = await createExchangeCode({
        sessionToken,
        csrfToken,
        deviceToken: deviceTokenValue,
        provider: 'google',
        userId: user.id,
        createdAt: Date.now(),
      });

      // Build deep link URL with only the opaque exchange code
      const deepLinkUrl = new URL('pagespace://auth-exchange');
      deepLinkUrl.searchParams.set('code', exchangeCode);
      deepLinkUrl.searchParams.set('provider', 'google');
      if (isNewlyProvisioned) {
        deepLinkUrl.searchParams.set('isNewUser', 'true');
      }

      loggers.auth.info('iOS OAuth deep link redirect', {
        userId: user.id,
        provider: 'google',
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
    loggers.auth.error('Google OAuth callback error', error as Error);
    securityAudit.logAuthFailure('unknown', getClientIP(req), 'google_oauth_error').catch((auditError) => {
      loggers.security.warn('[GoogleCallback] audit logAuthFailure failed', { error: auditError instanceof Error ? auditError.message : String(auditError) });
    });
    const errorRedirectBase = process.env.NEXTAUTH_URL || process.env.WEB_APP_URL || new URL(req.url).origin;
    return NextResponse.redirect(new URL('/auth/signin?error=oauth_error', errorRedirectBase));
  }
}
