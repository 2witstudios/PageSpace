import { OAuth2Client } from 'google-auth-library';
import { sessionService, generateCSRFToken, SESSION_DURATION_MS } from '@pagespace/lib/auth';
import { createId } from '@paralleldrive/cuid2';
import { loggers, auditRequest, validateOrCreateDeviceToken, maskEmail } from '@pagespace/lib/server';
import { trackAuthEvent } from '@pagespace/lib/activity-tracker';
import { z } from 'zod/v4';
import { provisionGettingStartedDriveIfNeeded } from '@/lib/onboarding/getting-started-drive';
import { getClientIP } from '@/lib/auth';
import { appendSessionCookie } from '@/lib/auth/cookie-config';
import { resolveGoogleAvatarImage } from '@/lib/auth/google-avatar';
import {
  checkDistributedRateLimit,
  resetDistributedRateLimit,
  DISTRIBUTED_RATE_LIMITS,
} from '@pagespace/lib/security';
import { authRepository } from '@/lib/repositories/auth-repository';

const client = new OAuth2Client();

const nativeAuthSchema = z.object({
  idToken: z.string().min(1, 'ID token is required'),
  platform: z.enum(['ios', 'android']),
  deviceId: z.string().min(1, 'Device ID is required'),
  deviceName: z.string().optional(),
});

/**
 * Native Google Sign-In endpoint for iOS/Android apps.
 * Receives a Google ID token from the native SDK and creates a session.
 */
export async function POST(req: Request) {
  const clientIP = getClientIP(req);

  try {
    // Rate limiting
    const ipRateLimit = await checkDistributedRateLimit(
      `oauth:native:ip:${clientIP}`,
      DISTRIBUTED_RATE_LIMITS.LOGIN
    );
    if (!ipRateLimit.allowed) {
      return Response.json(
        {
          error: 'Too many login attempts. Please try again later.',
          retryAfter: ipRateLimit.retryAfter,
        },
        {
          status: 429,
          headers: {
            'Retry-After': String(ipRateLimit.retryAfter || 900),
          },
        }
      );
    }

    const body = await req.json();
    const validation = nativeAuthSchema.safeParse(body);

    if (!validation.success) {
      return Response.json(
        { error: 'Invalid request', details: validation.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    const { idToken, platform, deviceId, deviceName } = validation.data;

    // Validate required environment variables
    if (!process.env.GOOGLE_OAUTH_CLIENT_ID || !process.env.GOOGLE_OAUTH_IOS_CLIENT_ID) {
      loggers.auth.error('Missing Google OAuth client IDs', {
        hasWebClientId: !!process.env.GOOGLE_OAUTH_CLIENT_ID,
        hasIosClientId: !!process.env.GOOGLE_OAUTH_IOS_CLIENT_ID,
      });
      return Response.json({ error: 'Google sign-in not configured' }, { status: 500 });
    }

    // Verify the ID token with Google
    // Accept both iOS client ID and web client ID for backend verification
    const ticket = await client.verifyIdToken({
      idToken,
      audience: [
        process.env.GOOGLE_OAUTH_CLIENT_ID, // Web client ID
        process.env.GOOGLE_OAUTH_IOS_CLIENT_ID, // iOS client ID
      ],
    });

    const payload = ticket.getPayload();
    if (!payload?.email) {
      loggers.auth.warn('Invalid Google ID token - missing email', { platform });
      auditRequest(req, {
        eventType: 'auth.login.failure',
        riskScore: 0.3,
        details: { reason: 'google_native_invalid_token' },
      });
      return Response.json({ error: 'Invalid token' }, { status: 401 });
    }

    const { sub: googleId, email, name, picture, email_verified } = payload;

    // Find or create user
    let user = await authRepository.findUserByGoogleIdOrEmail(googleId!, email);

    let isNewUser = false;
    if (user) {
      const resolvedImage = await resolveGoogleAvatarImage({
        userId: user.id,
        pictureUrl: picture,
        existingImage: user.image,
      });

      // Update existing user if needed
      if (
        !user.googleId ||
        !user.name ||
        user.image !== resolvedImage ||
        (email_verified && !user.emailVerified)
      ) {
        loggers.auth.info('Updating existing user via native Google OAuth', { email: maskEmail(email), platform });
        await authRepository.updateUser(user.id, {
          googleId: googleId || user.googleId,
          provider: user.provider === 'email' ? 'google' : user.provider,
          name: user.name || name || email.split('@')[0],
          image: resolvedImage,
          emailVerified: email_verified ? new Date() : user.emailVerified,
        });

        user = await authRepository.findUserById(user.id) || user;
      }
    } else {
      isNewUser = true;
      loggers.auth.info('Creating new user via native Google OAuth', { email: maskEmail(email), platform });
      user = await authRepository.createUser({
        id: createId(),
        name: name || email.split('@')[0],
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

      loggers.auth.info('New user created via native Google OAuth', { userId: user.id, platform });
    }

    // Provision getting started drive for new users
    if (isNewUser) {
      await provisionGettingStartedDriveIfNeeded(user.id).catch((error) => {
        loggers.auth.error('Failed to provision Getting Started drive', error as Error, {
          userId: user.id,
          provider: 'google-native',
        });
      });
    }

    // SESSION FIXATION PREVENTION: Revoke all existing sessions before creating new one
    const revokedCount = await sessionService.revokeAllUserSessions(user.id, 'new_login');
    if (revokedCount > 0) {
      loggers.auth.info('Revoked existing sessions on native Google OAuth login', {
        userId: user.id,
        count: revokedCount,
        platform,
      });
    }

    // Create session
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
      loggers.auth.error('Failed to validate newly created session', { userId: user.id, platform });
      return Response.json({ error: 'Session creation failed' }, { status: 500 });
    }

    const csrfToken = generateCSRFToken(sessionClaims.sessionId);

    // Create device token
    const { deviceToken } = await validateOrCreateDeviceToken({
      providedDeviceToken: undefined,
      userId: user.id,
      deviceId,
      platform,
      tokenVersion: user.tokenVersion,
      deviceName: deviceName || `${platform === 'ios' ? 'iOS' : 'Android'} App`,
      userAgent: req.headers.get('user-agent') || undefined,
      ipAddress: clientIP !== 'unknown' ? clientIP : undefined,
    });

    // Reset rate limit on success
    await resetDistributedRateLimit(`oauth:native:ip:${clientIP}`).catch(err => {
      loggers.auth.warn('Rate limit reset failed', {
        error: err instanceof Error ? err.message : String(err),
        ip: clientIP,
      });
    });

    // Log auth events
    auditRequest(req, {
      eventType: 'auth.login.success',
      userId: user.id,
      sessionId: sessionClaims.sessionId,
      details: { method: `Google OAuth Native (${platform})` },
    });
    trackAuthEvent(user.id, 'login', {
      email,
      ip: clientIP,
      provider: 'google-native',
      platform,
      userAgent: req.headers.get('user-agent'),
    });

    loggers.auth.info('Native Google OAuth login successful', {
      userId: user.id,
      platform,
      isNewUser,
    });

    // Set session cookie so middleware recognizes the authenticated session
    const headers = new Headers();
    appendSessionCookie(headers, sessionToken);

    return new Response(JSON.stringify({
      sessionToken,
      csrfToken,
      deviceToken,
      isNewUser,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        image: user.image,
        emailVerified: user.emailVerified,
      },
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': headers.get('Set-Cookie') || '',
      },
    });
  } catch (error) {
    loggers.auth.error('Native Google auth error', error as Error, { clientIP });
    auditRequest(req, {
      eventType: 'auth.login.failure',
      riskScore: 0.3,
      details: { reason: 'google_native_error' },
    });

    // Check if it's a Google token verification error
    if (error instanceof Error && error.message.includes('Token used too late')) {
      return Response.json({ error: 'Token expired. Please try again.' }, { status: 401 });
    }

    return Response.json({ error: 'Authentication failed' }, { status: 500 });
  }
}
