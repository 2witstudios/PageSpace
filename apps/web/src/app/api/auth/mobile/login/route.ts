import { users, refreshTokens } from '@pagespace/db';
import { db, eq } from '@pagespace/db';
import bcrypt from 'bcryptjs';
import { z } from 'zod/v4';
import {
  generateAccessToken,
  generateRefreshToken,
  getRefreshTokenMaxAge,
  checkRateLimit,
  resetRateLimit,
  RATE_LIMIT_CONFIGS,
  decodeToken,
  createDeviceTokenRecord,
  validateDeviceToken,
  updateDeviceTokenActivity,
} from '@pagespace/lib/server';
import { generateCSRFToken, getSessionIdFromJWT } from '@pagespace/lib/server';
import { createId } from '@paralleldrive/cuid2';
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
    const refreshToken = await generateRefreshToken(user.id, user.tokenVersion, user.role);

    const refreshTokenPayload = await decodeToken(refreshToken);
    const refreshTokenExpiresAt = refreshTokenPayload?.exp
      ? new Date(refreshTokenPayload.exp * 1000)
      : new Date(Date.now() + getRefreshTokenMaxAge() * 1000);

    let deviceTokenValue = existingDeviceToken ?? null;
    let deviceTokenRecordId: string | null = null;

    if (deviceTokenValue) {
      const storedDeviceToken = await validateDeviceToken(deviceTokenValue);
      if (
        !storedDeviceToken ||
        storedDeviceToken.userId !== user.id ||
        storedDeviceToken.deviceId !== deviceId ||
        storedDeviceToken.platform !== platform
      ) {
        deviceTokenValue = null;
      } else {
        deviceTokenRecordId = storedDeviceToken.id;
        await updateDeviceTokenActivity(storedDeviceToken.id, clientIP);
      }
    }

    if (!deviceTokenValue) {
      const { id: newDeviceTokenId, token: newDeviceToken } = await createDeviceTokenRecord(
        user.id,
        deviceId,
        platform,
        user.tokenVersion,
        {
          deviceName: deviceName || undefined,
          userAgent: req.headers.get('user-agent') || undefined,
          ipAddress: clientIP === 'unknown' ? undefined : clientIP,
          location: undefined,
        }
      );

      deviceTokenValue = newDeviceToken;
      deviceTokenRecordId = newDeviceTokenId;
    }

    await db.insert(refreshTokens).values({
      id: createId(),
      token: refreshToken,
      userId: user.id,
      device: req.headers.get('user-agent'),
      userAgent: req.headers.get('user-agent'),
      ip: clientIP,
      lastUsedAt: new Date(),
      platform,
      deviceTokenId: deviceTokenRecordId,
      expiresAt: refreshTokenExpiresAt,
    });

    // Reset rate limits on successful login
    resetRateLimit(clientIP);
    resetRateLimit(email.toLowerCase());

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

    // Return tokens in JSON body for mobile clients
    return Response.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        image: user.image,
      },
      token: accessToken,
      refreshToken: refreshToken,
      csrfToken: csrfToken,
      deviceToken: deviceTokenValue,
    }, { status: 200 });

  } catch (error) {
    loggers.auth.error('Mobile login error', error as Error);
    return Response.json({ error: 'An unexpected error occurred.' }, { status: 500 });
  }
}
