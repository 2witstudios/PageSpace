import { users, db, eq, or } from '@pagespace/db';
import { z } from 'zod/v4';
import { sessionService, generateCSRFToken, SESSION_DURATION_MS } from '@pagespace/lib/auth';
import { validateOrCreateDeviceToken } from '@pagespace/lib/server';
import {
  checkDistributedRateLimit,
  resetDistributedRateLimit,
  DISTRIBUTED_RATE_LIMITS,
} from '@pagespace/lib/security';
import { createId } from '@paralleldrive/cuid2';
import { loggers, logAuthEvent } from '@pagespace/lib/server';
import { trackAuthEvent } from '@pagespace/lib/activity-tracker';
import { OAuth2Client } from 'google-auth-library';
import { NextResponse } from 'next/server';
import { provisionGettingStartedDriveIfNeeded } from '@/lib/onboarding/getting-started-drive';
import { getClientIP } from '@/lib/auth';
import { appendSessionCookie } from '@/lib/auth/cookie-config';

const oneTapSchema = z.object({
  credential: z.string().min(1, 'Credential is required'),
  platform: z.enum(['web', 'desktop']).optional().default('web'),
  deviceId: z.string().optional(),
  deviceName: z.string().optional(),
});

const client = new OAuth2Client(process.env.GOOGLE_OAUTH_CLIENT_ID);

export async function POST(req: Request) {
  try {
    // Validate required OAuth environment variables
    if (!process.env.GOOGLE_OAUTH_CLIENT_ID) {
      loggers.auth.error('Missing GOOGLE_OAUTH_CLIENT_ID for One Tap');
      return NextResponse.json(
        { error: 'Google sign-in not configured' },
        { status: 500 }
      );
    }

    const body = await req.json();
    const validation = oneTapSchema.safeParse(body);

    if (!validation.success) {
      loggers.auth.warn('Invalid One Tap request', validation.error);
      return NextResponse.json(
        { error: 'Invalid request', details: validation.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    const { credential, platform, deviceId, deviceName } = validation.data;

    // Rate limiting by IP address
    const clientIP = getClientIP(req);

    const ipRateLimit = await checkDistributedRateLimit(
      `oauth:onetap:ip:${clientIP}`,
      DISTRIBUTED_RATE_LIMITS.LOGIN
    );
    if (!ipRateLimit.allowed) {
      return NextResponse.json(
        {
          error: 'Too many sign-in attempts. Please try again later.',
          retryAfter: ipRateLimit.retryAfter,
        },
        {
          status: 429,
          headers: {
            'Retry-After': String(ipRateLimit.retryAfter || 900),
            'X-RateLimit-Limit': String(DISTRIBUTED_RATE_LIMITS.LOGIN.maxAttempts),
            'X-RateLimit-Remaining': '0',
          },
        }
      );
    }

    // Verify the Google ID token
    let payload;
    try {
      const ticket = await client.verifyIdToken({
        idToken: credential,
        audience: process.env.GOOGLE_OAUTH_CLIENT_ID,
      });
      payload = ticket.getPayload();
    } catch (verifyError) {
      loggers.auth.warn('Google ID token verification failed', {
        error: verifyError instanceof Error ? verifyError.message : String(verifyError),
      });
      return NextResponse.json(
        { error: 'Invalid Google credential. Please try again.' },
        { status: 401 }
      );
    }

    if (!payload) {
      loggers.auth.error('Empty payload from Google ID token');
      return NextResponse.json(
        { error: 'Invalid Google credential' },
        { status: 401 }
      );
    }

    const { sub: googleId, email, name, picture, email_verified } = payload;

    if (!email) {
      loggers.auth.error('Missing email in Google credential');
      return NextResponse.json(
        { error: 'Email is required for sign-in' },
        { status: 400 }
      );
    }

    // Create fallback name if Google doesn't provide one
    const userName = name || email.split('@')[0] || 'User';

    // Check if user exists by Google ID or email
    let user = await db.query.users.findFirst({
      where: or(eq(users.googleId, googleId), eq(users.email, email)),
    });

    let isNewUser = false;

    if (user) {
      // Update existing user with Google ID if not set, or update other profile info
      if (!user.googleId || !user.name || user.image !== picture) {
        loggers.auth.info('Updating existing user via Google One Tap', { email });
        await db
          .update(users)
          .set({
            googleId: googleId || user.googleId,
            provider: user.password ? 'both' : 'google',
            name: user.name || userName,
            image: picture || user.image,
            emailVerified: email_verified ? new Date() : user.emailVerified,
          })
          .where(eq(users.id, user.id));

        // Refetch the user to get updated data
        user =
          (await db.query.users.findFirst({
            where: eq(users.id, user.id),
          })) || user;
        loggers.auth.info('User updated via Google One Tap', {
          userId: user.id,
          name: user.name,
        });
      }
    } else {
      // Create new user
      isNewUser = true;
      loggers.auth.info('Creating new user via Google One Tap', { email });
      const [newUser] = await db
        .insert(users)
        .values({
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
        })
        .returning();

      user = newUser;
      loggers.auth.info('New user created via Google One Tap', {
        userId: user.id,
        name: user.name,
      });
    }

    // Provision Getting Started drive for new or existing users without drives
    let provisionedDrive: { driveId: string } | null = null;
    try {
      provisionedDrive = await provisionGettingStartedDriveIfNeeded(user.id);
    } catch (error) {
      loggers.auth.error('Failed to provision Getting Started drive', error as Error, {
        userId: user.id,
        provider: 'google-one-tap',
      });
    }

    // Reset rate limits on successful login
    try {
      await resetDistributedRateLimit(`oauth:onetap:ip:${clientIP}`);
    } catch (error) {
      loggers.auth.warn('Rate limit reset failed after successful One Tap', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Log successful login
    logAuthEvent('login', user.id, email, clientIP, 'Google One Tap');

    // Track login event (mask email to prevent PII in activity logs)
    const maskedEmail = email.replace(/(.{2}).*(@.*)/, '$1***$2');
    trackAuthEvent(user.id, isNewUser ? 'signup' : 'login', {
      email: maskedEmail,
      ip: clientIP,
      provider: 'google-one-tap',
      userAgent: req.headers.get('user-agent'),
    });

    const redirectTo = provisionedDrive ? `/dashboard/${provisionedDrive.driveId}` : '/dashboard';

    // DESKTOP PLATFORM: Return device token in response body
    // Desktop uses device tokens, not web sessions
    if (platform === 'desktop') {
      if (!deviceId) {
        loggers.auth.error('Desktop One Tap missing deviceId', {
          userId: user.id,
          email: user.email,
        });
        return NextResponse.json(
          { error: 'Device ID required for desktop sign-in' },
          { status: 400 }
        );
      }

      // Generate device token for desktop
      const { deviceToken: deviceTokenValue } = await validateOrCreateDeviceToken({
        providedDeviceToken: undefined,
        userId: user.id,
        deviceId: deviceId,
        platform: 'desktop',
        tokenVersion: user.tokenVersion,
        deviceName: deviceName || req.headers.get('user-agent') || 'Desktop App',
        userAgent: req.headers.get('user-agent') || undefined,
        ipAddress: clientIP,
      });

      return NextResponse.json({
        success: true,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
        },
        tokens: {
          deviceToken: deviceTokenValue,
        },
        redirectTo,
        isNewUser,
      });
    }

    // WEB PLATFORM: Use session-based authentication
    // SESSION FIXATION PREVENTION: Revoke all existing sessions before creating new one
    const revokedCount = await sessionService.revokeAllUserSessions(user.id, 'new_login');
    if (revokedCount > 0) {
      loggers.auth.info('Revoked existing sessions on Google One Tap login', { userId: user.id, count: revokedCount });
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
      return NextResponse.json({ error: 'Session creation failed' }, { status: 500 });
    }

    const csrfToken = generateCSRFToken(sessionClaims.sessionId);

    const headers = new Headers();
    appendSessionCookie(headers, sessionToken);

    return NextResponse.json(
      {
        success: true,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
        },
        csrfToken,
        redirectTo,
        isNewUser,
      },
      { headers }
    );
  } catch (error) {
    loggers.auth.error('Google One Tap error', error as Error);
    return NextResponse.json(
      { error: 'An unexpected error occurred. Please try again.' },
      { status: 500 }
    );
  }
}
