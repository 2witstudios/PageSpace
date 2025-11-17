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
  validateOrCreateDeviceToken,
} from '@pagespace/lib/server';
import { serialize } from 'cookie';
import { createId } from '@paralleldrive/cuid2';
import { loggers, logAuthEvent } from '@pagespace/lib/server';
import { trackAuthEvent } from '@pagespace/lib/activity-tracker';

const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(1, {
      error: "Password is required"
  }),
  // Optional device information for device token creation
  deviceId: z.string().optional(),
  deviceName: z.string().optional(),
  deviceToken: z.string().optional(),
});

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const validation = loginSchema.safeParse(body);

    if (!validation.success) {
      return Response.json({ errors: validation.error.flatten().fieldErrors }, { status: 400 });
    }

    const { email, password, deviceId, deviceName, deviceToken: existingDeviceToken } = validation.data;

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

    const refreshPayload = await decodeToken(refreshToken);
    const refreshExpiresAt = refreshPayload?.exp
      ? new Date(refreshPayload.exp * 1000)
      : new Date(Date.now() + getRefreshTokenMaxAge() * 1000);

    // Create or validate device token for web platform
    let deviceTokenValue: string | undefined;
    if (deviceId) {
      const { deviceToken: createdDeviceToken } = await validateOrCreateDeviceToken({
        providedDeviceToken: existingDeviceToken,
        userId: user.id,
        deviceId,
        platform: 'web',
        tokenVersion: user.tokenVersion,
        deviceName,
        userAgent: req.headers.get('user-agent') ?? undefined,
        ipAddress: clientIP !== 'unknown' ? clientIP : undefined,
      });
      deviceTokenValue = createdDeviceToken;
    }

    await db.insert(refreshTokens).values({
      id: createId(),
      token: refreshToken,
      userId: user.id,
      device: req.headers.get('user-agent'),
      userAgent: req.headers.get('user-agent'),
      ip: clientIP,
      lastUsedAt: new Date(),
      platform: 'web',
      expiresAt: refreshExpiresAt,
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
      userAgent: req.headers.get('user-agent')
    });

    const isProduction = process.env.NODE_ENV === 'production';
    
    const accessTokenCookie = serialize('accessToken', accessToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'strict',
      path: '/',
      maxAge: 15 * 60, // 15 minutes
      ...(isProduction && { domain: process.env.COOKIE_DOMAIN })
    });

    const refreshTokenCookie = serialize('refreshToken', refreshToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'strict',
      path: '/',
      maxAge: getRefreshTokenMaxAge(), // Configurable via REFRESH_TOKEN_TTL env var (default: 30d)
      ...(isProduction && { domain: process.env.COOKIE_DOMAIN })
    });

    const headers = new Headers();
    headers.append('Set-Cookie', accessTokenCookie);
    headers.append('Set-Cookie', refreshTokenCookie);

    return Response.json({
      id: user.id,
      name: user.name,
      email: user.email,
      ...(deviceTokenValue && { deviceToken: deviceTokenValue }),
    }, { status: 200, headers });

  } catch (error) {
    loggers.auth.error('Login error', error as Error);
    return Response.json({ error: 'An unexpected error occurred.' }, { status: 500 });
  }
}