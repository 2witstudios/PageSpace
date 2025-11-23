/**
 * Mobile Google OAuth Token Exchange Endpoint
 *
 * This endpoint accepts an ID token from the iOS Google Sign-In SDK,
 * verifies it server-side, and returns JWT tokens for authentication.
 *
 * Flow:
 * 1. iOS app uses GoogleSignIn SDK to authenticate user
 * 2. iOS app receives Google ID token
 * 3. iOS app sends ID token to this endpoint
 * 4. Server verifies ID token with Google
 * 5. Server creates/links user account
 * 6. Server returns JWT access + refresh tokens
 *
 * Security Model:
 *
 * This endpoint uses the "ID Token Flow" rather than the "Authorization Code Flow".
 * The security model differs from web OAuth in several important ways:
 *
 * 1. **No State Parameter Required**:
 *    - Web OAuth uses state parameter to prevent CSRF attacks during redirects
 *    - Mobile ID token flow has no redirect - iOS app directly sends ID token to this endpoint
 *    - The ID token itself is cryptographically signed by Google and includes audience claim
 *    - We verify the token signature and audience server-side, making state parameter unnecessary
 *
 * 2. **CSRF Protection for Subsequent Requests**:
 *    - While state parameter isn't needed for token exchange, subsequent API requests need CSRF protection
 *    - We generate and return a CSRF token tied to the user's session
 *    - Mobile client must include this CSRF token in X-CSRF-Token header for state-changing operations
 *    - CSRF token is derived from sessionId (userId + tokenVersion + iat) to prevent forgery
 *
 * 3. **Token Verification as Security Boundary**:
 *    - Google's ID token signature verification is the primary security control
 *    - We verify: signature validity, issuer (accounts.google.com), audience (our client ID), expiration
 *    - If verification passes, we trust the claims (sub, email, email_verified, etc.)
 *    - No additional OAuth callback validation needed since there's no callback
 *
 * 4. **Rate Limiting as Defense in Depth**:
 *    - Dual rate limiting prevents abuse: IP-based (5/15min) and OAuth-specific (10/5min)
 *    - OAuth rate limit prevents resource exhaustion from invalid token spam
 *    - Both limits reset on successful authentication
 *
 * References:
 * - Google Sign-In iOS: https://developers.google.com/identity/sign-in/ios
 * - OAuth 2.0 for Native Apps (RFC 8252): https://tools.ietf.org/html/rfc8252
 * - ID Token Verification: https://developers.google.com/identity/protocols/oauth2/openid-connect#validatinganidtoken
 */

import { z } from 'zod/v4';
import {
  generateAccessToken,
  generateRefreshToken,
  getRefreshTokenMaxAge,
  checkRateLimit,
  resetRateLimit,
  RATE_LIMIT_CONFIGS,
  decodeToken,
  generateCSRFToken,
  getSessionIdFromJWT,
  validateOrCreateDeviceToken,
} from '@pagespace/lib/server';
import { loggers, logAuthEvent } from '@pagespace/lib/server';
import { trackAuthEvent } from '@pagespace/lib/activity-tracker';
import { verifyOAuthIdToken, createOrLinkOAuthUser, saveRefreshToken, OAuthProvider } from '@pagespace/lib/server';
import type { MobileOAuthResponse } from '@pagespace/lib/server';

const oauthExchangeSchema = z.object({
  idToken: z.string().min(1, 'ID token is required'),
  deviceId: z.string().min(1, { message: 'Device identifier is required' }),
  platform: z.enum(['ios', 'android', 'desktop']).default('ios'),
  deviceName: z.string().optional(),
  appVersion: z.string().optional(),
  deviceToken: z.string().optional(),
  // Note: state parameter not needed for ID token flow
  // CSRF protection provided via returned CSRF token
});

export async function POST(req: Request) {
  let platform: 'ios' | 'android' | 'desktop' = 'ios';

  try {
    const body = await req.json();
    const validation = oauthExchangeSchema.safeParse(body);

    if (!validation.success) {
      loggers.auth.warn('Invalid mobile OAuth request', validation.error);
      return Response.json(
        { errors: validation.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    const {
      idToken,
      deviceId,
      platform: requestPlatform,
      deviceName,
      appVersion,
      deviceToken: providedDeviceToken,
    } = validation.data;
    platform = requestPlatform;

    // Rate limiting by IP address
    const clientIP =
      req.headers.get('x-forwarded-for')?.split(',')[0] ||
      req.headers.get('x-real-ip') ||
      'unknown';

    const ipRateLimit = checkRateLimit(clientIP, RATE_LIMIT_CONFIGS.LOGIN);
    if (!ipRateLimit.allowed) {
      return Response.json(
        {
          error: 'Too many authentication attempts. Please try again later.',
          retryAfter: ipRateLimit.retryAfter,
        },
        {
          status: 429,
          headers: {
            'Retry-After': ipRateLimit.retryAfter?.toString() || '900',
          },
        }
      );
    }

    // Additional rate limiting specifically for OAuth token verification
    // Prevents resource exhaustion from invalid token spam
    const ipOAuthRateLimit = checkRateLimit(`oauth:${clientIP}`, {
      maxAttempts: 10,
      windowMs: 5 * 60 * 1000, // 5 minutes
      blockDurationMs: 5 * 60 * 1000, // 5 minutes
      progressiveDelay: false,
    });

    if (!ipOAuthRateLimit.allowed) {
      loggers.auth.warn('OAuth verification rate limit exceeded', { clientIP });
      trackAuthEvent(undefined, 'failed_oauth', {
        reason: 'rate_limit_verification',
        ip: clientIP,
        platform,
      });
      return Response.json(
        {
          error: 'Too many OAuth verification attempts. Please try again later.',
          retryAfter: ipOAuthRateLimit.retryAfter,
        },
        {
          status: 429,
          headers: {
            'Retry-After': ipOAuthRateLimit.retryAfter?.toString() || '300',
          },
        }
      );
    }

    // Verify the ID token with Google
    loggers.auth.info('Verifying Google ID token for mobile OAuth');
    const verificationResult = await verifyOAuthIdToken(
      OAuthProvider.GOOGLE,
      idToken
    );

    if (!verificationResult.success || !verificationResult.userInfo) {
      loggers.auth.warn('Google ID token verification failed', {
        error: verificationResult.error,
      });

      // Track failed OAuth attempt
      trackAuthEvent(undefined, 'failed_oauth', {
        provider: 'google',
        reason: verificationResult.error,
        ip: clientIP,
        platform,
      });

      return Response.json(
        { error: verificationResult.error || 'Invalid ID token' },
        { status: 401 }
      );
    }

    const { userInfo } = verificationResult;
    loggers.auth.info('Google ID token verified', {
      email: userInfo.email,
      provider: userInfo.provider,
    });

    // Rate limiting by email
    const emailRateLimit = checkRateLimit(
      userInfo.email.toLowerCase(),
      RATE_LIMIT_CONFIGS.LOGIN
    );
    if (!emailRateLimit.allowed) {
      return Response.json(
        {
          error: 'Too many authentication attempts for this email. Please try again later.',
          retryAfter: emailRateLimit.retryAfter,
        },
        {
          status: 429,
          headers: {
            'Retry-After': emailRateLimit.retryAfter?.toString() || '900',
          },
        }
      );
    }

    // Create or link user account
    loggers.auth.info('Creating or linking OAuth user', {
      email: userInfo.email,
      provider: userInfo.provider,
    });

    const user = await createOrLinkOAuthUser(userInfo);

    loggers.auth.info('OAuth user created/linked', {
      userId: user.id,
      email: user.email,
      provider: user.provider,
    });

    // Generate JWT tokens
    const accessToken = await generateAccessToken(
      user.id,
      user.tokenVersion,
      user.role
    );
    const refreshToken = await generateRefreshToken(
      user.id,
      user.tokenVersion,
      user.role
    );

    // Save refresh token to database
    const refreshTokenPayload = await decodeToken(refreshToken);
    const refreshTokenExpiresAt = refreshTokenPayload?.exp
      ? new Date(refreshTokenPayload.exp * 1000)
      : new Date(Date.now() + getRefreshTokenMaxAge() * 1000);

    const { deviceToken: deviceTokenValue, deviceTokenRecordId } = await validateOrCreateDeviceToken({
      providedDeviceToken,
      userId: user.id,
      deviceId,
      platform,
      tokenVersion: user.tokenVersion,
      deviceName: deviceName || undefined,
      userAgent: req.headers.get('user-agent') || undefined,
      ipAddress: clientIP,
    });

    await saveRefreshToken(refreshToken, user.id, {
      device: req.headers.get('user-agent'),
      userAgent: req.headers.get('user-agent'),
      ip: clientIP,
      platform,
      deviceTokenId: deviceTokenRecordId,
      expiresAt: refreshTokenExpiresAt,
      lastUsedAt: new Date(),
    });

    // Reset rate limits on successful authentication
    resetRateLimit(clientIP);
    resetRateLimit(`oauth:${clientIP}`); // Reset OAuth verification rate limit
    resetRateLimit(userInfo.email.toLowerCase());

    // Log successful OAuth login
    logAuthEvent('login', user.id, user.email, clientIP, 'Google OAuth Mobile');

    // Track successful OAuth login
    trackAuthEvent(user.id, 'login', {
      email: user.email,
      ip: clientIP,
      provider: 'google',
      userAgent: req.headers.get('user-agent'),
      platform,
      appVersion,
    });

    // Generate CSRF token for mobile client
    const decoded = await decodeToken(accessToken);
    if (!decoded?.iat) {
      loggers.auth.error('Failed to decode access token for CSRF generation');
      return Response.json(
        { error: 'Failed to generate session' },
        { status: 500 }
      );
    }

    const sessionId = getSessionIdFromJWT({
      userId: user.id,
      tokenVersion: user.tokenVersion,
      iat: decoded.iat,
    });
    const csrfToken = generateCSRFToken(sessionId);

    // Return tokens in JSON response for mobile client
    const response: MobileOAuthResponse = {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        picture: user.image,
        provider: user.provider,
        role: user.role,
      },
      token: accessToken,
      refreshToken: refreshToken,
      csrfToken: csrfToken,
      deviceToken: deviceTokenValue,
    };

    loggers.auth.info('Mobile OAuth successful', {
      userId: user.id,
      provider: 'google',
    });

    return Response.json(response, { status: 200 });
  } catch (error) {
    loggers.auth.error('Mobile Google OAuth error', error as Error);

    // Track failed OAuth attempt
    trackAuthEvent(undefined, 'failed_oauth', {
      provider: 'google',
      error: error instanceof Error ? error.message : 'Unknown error',
      platform,
    });

    return Response.json(
      { error: 'An unexpected error occurred during authentication.' },
      { status: 500 }
    );
  }
}
