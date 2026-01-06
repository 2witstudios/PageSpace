import { users } from '@pagespace/db';
import { db, eq } from '@pagespace/db';
import bcrypt from 'bcryptjs';
import { z } from 'zod/v4';
import {
  generateAccessToken,
  checkRateLimit,
  resetRateLimit,
  RATE_LIMIT_CONFIGS,
  decodeToken,
  validateOrCreateDeviceToken,
} from '@pagespace/lib/server';
import {
  checkDistributedRateLimit,
  resetDistributedRateLimit,
  DISTRIBUTED_RATE_LIMITS,
} from '@pagespace/lib/security';
import { generateCSRFToken, getSessionIdFromJWT } from '@pagespace/lib/server';
import { loggers, logAuthEvent } from '@pagespace/lib/server';
import { trackAuthEvent } from '@pagespace/lib/activity-tracker';

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

    // Rate limiting by IP address and email
    const clientIP = req.headers.get('x-forwarded-for')?.split(',')[0] ||
                     req.headers.get('x-real-ip') ||
                     'unknown';

    const ipRateLimit = checkRateLimit(clientIP, RATE_LIMIT_CONFIGS.LOGIN);
    const emailRateLimit = checkRateLimit(email.toLowerCase(), RATE_LIMIT_CONFIGS.LOGIN);

    if (!ipRateLimit.allowed) {
      return Response.json(
        {
          error: 'Too many login attempts from this IP address. Please try again later.',
          retryAfter: ipRateLimit.retryAfter
        },
        {
          status: 429,
          headers: {
            'Retry-After': ipRateLimit.retryAfter?.toString() || '900'
          }
        }
      );
    }

    if (!emailRateLimit.allowed) {
      return Response.json(
        {
          error: 'Too many login attempts for this email. Please try again later.',
          retryAfter: emailRateLimit.retryAfter
        },
        {
          status: 429,
          headers: {
            'Retry-After': emailRateLimit.retryAfter?.toString() || '900'
          }
        }
      );
    }

    // Distributed rate limiting (P1-T5)
    const distributedIpLimit = await checkDistributedRateLimit(
      `login:ip:${clientIP}`,
      DISTRIBUTED_RATE_LIMITS.LOGIN
    );
    const distributedEmailLimit = await checkDistributedRateLimit(
      `login:email:${email.toLowerCase()}`,
      DISTRIBUTED_RATE_LIMITS.LOGIN
    );

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

    const accessToken = await generateAccessToken(user.id, user.tokenVersion, user.role);

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

    // Reset rate limits on successful login
    resetRateLimit(clientIP);
    resetRateLimit(email.toLowerCase());

    // Reset distributed rate limits (P1-T5)
    await resetDistributedRateLimit(`login:ip:${clientIP}`);
    await resetDistributedRateLimit(`login:email:${email.toLowerCase()}`);

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

    // Generate CSRF token for mobile client
    // Decode the access token to get its actual iat claim
    const decoded = await decodeToken(accessToken);
    if (!decoded?.iat) {
      loggers.auth.error('Failed to decode access token for CSRF generation');
      return Response.json({ error: 'Failed to generate session' }, { status: 500 });
    }

    const sessionId = getSessionIdFromJWT({
      userId: user.id,
      tokenVersion: user.tokenVersion,
      iat: decoded.iat
    });
    const csrfToken = generateCSRFToken(sessionId);

    // Return tokens in JSON body for mobile clients (device-token-only pattern)
    const headers = new Headers();
    // Add rate limit headers (P1-T5)
    headers.set('X-RateLimit-Limit', String(DISTRIBUTED_RATE_LIMITS.LOGIN.maxAttempts));
    headers.set('X-RateLimit-Remaining', String(Math.min(distributedIpLimit.attemptsRemaining ?? DISTRIBUTED_RATE_LIMITS.LOGIN.maxAttempts, distributedEmailLimit.attemptsRemaining ?? DISTRIBUTED_RATE_LIMITS.LOGIN.maxAttempts)));

    return Response.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        image: user.image,
      },
      token: accessToken,
      csrfToken: csrfToken,
      deviceToken: deviceTokenValue,
    }, { status: 200, headers });

  } catch (error) {
    loggers.auth.error('Mobile login error', error as Error);
    return Response.json({ error: 'An unexpected error occurred.' }, { status: 500 });
  }
}
