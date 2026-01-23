import bcrypt from 'bcryptjs';
import { z } from 'zod/v4';
import {
  generateAccessToken,
  generateRefreshToken,
  getRefreshTokenMaxAge,
  decodeToken,
  validateOrCreateDeviceToken,
} from '@pagespace/lib/server';
import {
  checkDistributedRateLimit,
  resetDistributedRateLimit,
  DISTRIBUTED_RATE_LIMITS,
} from '@pagespace/lib/security';
import { parse } from 'cookie';
import { loggers, logAuthEvent, logSecurityEvent } from '@pagespace/lib/server';
import { trackAuthEvent } from '@pagespace/lib/activity-tracker';
import { provisionGettingStartedDriveIfNeeded } from '@/lib/onboarding/getting-started-drive';
import { validateLoginCSRFToken, getClientIP, appendAuthCookies } from '@/lib/auth';
import { authRepository } from '@/lib/repositories/auth-repository';

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
    // Get client IP early for logging
    const clientIP = getClientIP(req);

    // Validate Login CSRF token to prevent Login CSRF attacks
    // This prevents attackers from forcing victims to log into attacker's account
    const csrfTokenHeader = req.headers.get('x-login-csrf-token');
    const cookieHeader = req.headers.get('cookie');
    const cookies = parse(cookieHeader || '');
    const csrfTokenCookie = cookies.login_csrf;

    // Both header and cookie must be present and match
    if (!csrfTokenHeader || !csrfTokenCookie) {
      logSecurityEvent('login_csrf_missing', {
        ip: clientIP,
        hasHeader: !!csrfTokenHeader,
        hasCookie: !!csrfTokenCookie,
      });
      return Response.json(
        {
          error: 'Login CSRF token required',
          code: 'LOGIN_CSRF_MISSING',
          details: 'Please refresh the page and try again',
        },
        { status: 403 }
      );
    }

    // Verify tokens match (double-submit pattern)
    if (csrfTokenHeader !== csrfTokenCookie) {
      logSecurityEvent('login_csrf_mismatch', { ip: clientIP });
      return Response.json(
        {
          error: 'Invalid login CSRF token',
          code: 'LOGIN_CSRF_MISMATCH',
          details: 'Please refresh the page and try again',
        },
        { status: 403 }
      );
    }

    // Validate token signature and expiry
    if (!validateLoginCSRFToken(csrfTokenHeader)) {
      logSecurityEvent('login_csrf_invalid', { ip: clientIP });
      return Response.json(
        {
          error: 'Invalid or expired login CSRF token',
          code: 'LOGIN_CSRF_INVALID',
          details: 'Please refresh the page and try again',
        },
        { status: 403 }
      );
    }

    const body = await req.json();
    const validation = loginSchema.safeParse(body);

    if (!validation.success) {
      return Response.json({ errors: validation.error.flatten().fieldErrors }, { status: 400 });
    }

    const { email, password, deviceId, deviceName, deviceToken: existingDeviceToken } = validation.data;

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

    const user = await authRepository.findUserByEmail(email);

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
    let deviceTokenRecordId: string | undefined;
    if (deviceId) {
      const { deviceToken: createdDeviceToken, deviceTokenRecordId: recordId } = await validateOrCreateDeviceToken({
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
      deviceTokenRecordId = recordId;
    }

    await authRepository.createRefreshToken({
      token: refreshToken,
      userId: user.id,
      device: req.headers.get('user-agent'),
      userAgent: req.headers.get('user-agent'),
      ip: clientIP,
      expiresAt: refreshExpiresAt,
      deviceTokenId: deviceTokenRecordId,
      platform: 'web',
    });

    // Reset rate limits on successful login (parallel, graceful - failures don't affect successful auth)
    const resetResults = await Promise.allSettled([
      resetDistributedRateLimit(`login:ip:${clientIP}`),
      resetDistributedRateLimit(`login:email:${email.toLowerCase()}`),
    ]);

    // Log any reset failures for observability
    const failures = resetResults.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failures.length > 0) {
      loggers.auth.warn('Rate limit reset failed after successful login', {
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
      userAgent: req.headers.get('user-agent')
    });

    const headers = new Headers();
    appendAuthCookies(headers, accessToken, refreshToken);
    headers.set('X-RateLimit-Limit', String(DISTRIBUTED_RATE_LIMITS.LOGIN.maxAttempts));
    // After successful login and rate limit reset, remaining attempts are back to max
    headers.set('X-RateLimit-Remaining', String(DISTRIBUTED_RATE_LIMITS.LOGIN.maxAttempts));

    let redirectTo: string | undefined;
    try {
      const provisionedDrive = await provisionGettingStartedDriveIfNeeded(user.id);
      if (provisionedDrive) {
        redirectTo = `/dashboard/${provisionedDrive.driveId}`;
      }
    } catch (error) {
      loggers.auth.error('Failed to provision Getting Started drive', error as Error, {
        userId: user.id,
      });
    }

    return Response.json({
      id: user.id,
      name: user.name,
      email: user.email,
      ...(deviceTokenValue && { deviceToken: deviceTokenValue }),
      ...(redirectTo && { redirectTo }),
    }, { status: 200, headers });

  } catch (error) {
    loggers.auth.error('Login error', error as Error);
    return Response.json({ error: 'An unexpected error occurred.' }, { status: 500 });
  }
}
