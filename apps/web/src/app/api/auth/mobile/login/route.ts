import { users } from '@pagespace/db';
import { db, eq } from '@pagespace/db';
import bcrypt from 'bcryptjs';
import { z } from 'zod/v4';
import {
  validateOrCreateDeviceToken,
} from '@pagespace/lib/server';
import {
  checkDistributedRateLimit,
  resetDistributedRateLimit,
  DISTRIBUTED_RATE_LIMITS,
} from '@pagespace/lib/security';
import { generateCSRFToken } from '@pagespace/lib/server';
import { sessionService } from '@pagespace/lib/auth';
import { loggers, logAuthEvent } from '@pagespace/lib/server';
import { trackAuthEvent } from '@pagespace/lib/activity-tracker';
import { getClientIP } from '@/lib/auth';

const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(1, {
    error: 'Password is required',
  }),
  deviceId: z.string().min(1, { message: 'Device identifier is required' }),
  platform: z.enum(['ios', 'android', 'desktop']).default('ios'),
  deviceName: z.string().optional(),
  appVersion: z.string().optional(),
  deviceToken: z.string().optional(),
});

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const validation = loginSchema.safeParse(body);

    if (!validation.success) {
      return Response.json({ errors: validation.error.flatten().fieldErrors }, { status: 400 });
    }

    const { email, password, deviceId, platform, deviceName, appVersion, deviceToken: existingDeviceToken } = validation.data;

    const clientIP = getClientIP(req);

    // Distributed rate limiting (parallel checks for better performance)
    const [distributedIpLimit, distributedEmailLimit] = await Promise.all([
      checkDistributedRateLimit(`login:ip:${clientIP}`, DISTRIBUTED_RATE_LIMITS.LOGIN),
      checkDistributedRateLimit(`login:email:${email.toLowerCase()}`, DISTRIBUTED_RATE_LIMITS.LOGIN),
    ]);

    if (!distributedIpLimit.allowed) {
      return Response.json(
        {
          error: 'Too many login attempts from this IP address. Please try again later.',
          retryAfter: distributedIpLimit.retryAfter,
        },
        {
          status: 429,
          headers: {
            'Retry-After': String(distributedIpLimit.retryAfter || 900),
            'X-RateLimit-Limit': String(DISTRIBUTED_RATE_LIMITS.LOGIN.maxAttempts),
            'X-RateLimit-Remaining': '0',
          },
        }
      );
    }

    if (!distributedEmailLimit.allowed) {
      return Response.json(
        {
          error: 'Too many login attempts for this email. Please try again later.',
          retryAfter: distributedEmailLimit.retryAfter,
        },
        {
          status: 429,
          headers: {
            'Retry-After': String(distributedEmailLimit.retryAfter || 900),
            'X-RateLimit-Limit': String(DISTRIBUTED_RATE_LIMITS.LOGIN.maxAttempts),
            'X-RateLimit-Remaining': '0',
          },
        }
      );
    }

    const user = await db.query.users.findFirst({
      where: eq(users.email, email),
    });

    // Always perform bcrypt comparison to prevent timing attacks
    // Use a fake hash for non-existent users to maintain consistent timing
    const passwordToCheck = user?.password || '$2a$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewY5GyYzpLLEm4Eu';
    const isValid = await bcrypt.compare(password, passwordToCheck);

    if (!user || !user.password || !isValid) {
      const reason = !user ? 'invalid_email' : 'invalid_password';
      logAuthEvent('failed', user?.id, email, clientIP, reason === 'invalid_email' ? 'Invalid email' : 'Invalid password');
      trackAuthEvent(user?.id, 'failed_login', { reason, email, ip: clientIP });
      return Response.json({ error: 'Invalid email or password' }, { status: 401 });
    }

    // Create session token (opaque, stored in DB)
    const sessionToken = await sessionService.createSession({
      userId: user.id,
      type: 'user',
      scopes: ['*'],
      expiresInMs: 90 * 24 * 60 * 60 * 1000, // 90 days for mobile
      createdByService: 'mobile-login',
      createdByIp: clientIP,
    });

    // Get session claims for CSRF generation
    const sessionClaims = await sessionService.validateSession(sessionToken);
    if (!sessionClaims) {
      loggers.auth.error('Failed to validate newly created session');
      return Response.json({ error: 'Failed to generate session' }, { status: 500 });
    }

    // Device token only - no refresh token needed for mobile (90-day sessions)
    const { deviceToken: deviceTokenValue } = await validateOrCreateDeviceToken({
      providedDeviceToken: existingDeviceToken,
      userId: user.id,
      deviceId,
      platform,
      tokenVersion: user.tokenVersion,
      deviceName: deviceName || undefined,
      userAgent: req.headers.get('user-agent') || undefined,
      ipAddress: clientIP,
    });

    // Reset rate limits on successful login (parallel, graceful - failures don't affect successful auth)
    const resetResults = await Promise.allSettled([
      resetDistributedRateLimit(`login:ip:${clientIP}`),
      resetDistributedRateLimit(`login:email:${email.toLowerCase()}`),
    ]);

    // Log any reset failures for observability
    const failures = resetResults.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failures.length > 0) {
      loggers.auth.warn('Rate limit reset failed after successful mobile login', {
        failureCount: failures.length,
        reasons: failures.map(f => f.reason?.message || String(f.reason)),
      });
    }

    // Log successful login
    logAuthEvent('login', user.id, email, clientIP);

    // Track login event
    trackAuthEvent(user.id, 'login', {
      email,
      ip: clientIP,
      userAgent: req.headers.get('user-agent'),
      platform,
      appVersion,
    });

    // Generate CSRF token using session ID
    const csrfToken = generateCSRFToken(sessionClaims.sessionId);

    // Return tokens in JSON body for mobile clients
    const headers = new Headers();
    headers.set('X-RateLimit-Limit', String(DISTRIBUTED_RATE_LIMITS.LOGIN.maxAttempts));
    // After successful login and rate limit reset, remaining attempts are back to max
    headers.set('X-RateLimit-Remaining', String(DISTRIBUTED_RATE_LIMITS.LOGIN.maxAttempts));

    return Response.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        image: user.image,
      },
      sessionToken,
      csrfToken,
      deviceToken: deviceTokenValue,
    }, { status: 200, headers });

  } catch (error) {
    loggers.auth.error('Mobile login error', error as Error);
    return Response.json({ error: 'An unexpected error occurred.' }, { status: 500 });
  }
}
