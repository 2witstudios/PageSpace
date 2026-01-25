import bcrypt from 'bcryptjs';
import { z } from 'zod/v4';
import { sessionService, generateCSRFToken, SESSION_DURATION_MS } from '@pagespace/lib/auth';
import {
  checkDistributedRateLimit,
  resetDistributedRateLimit,
  DISTRIBUTED_RATE_LIMITS,
} from '@pagespace/lib/security';
import { parse } from 'cookie';
import { loggers, logAuthEvent, logSecurityEvent } from '@pagespace/lib/server';
import { trackAuthEvent } from '@pagespace/lib/activity-tracker';
import { provisionGettingStartedDriveIfNeeded } from '@/lib/onboarding/getting-started-drive';
import { validateLoginCSRFToken, getClientIP } from '@/lib/auth';
import { appendSessionCookie } from '@/lib/auth/cookie-config';
import { authRepository } from '@/lib/repositories/auth-repository';

const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(1, 'Password is required'),
});

export async function POST(req: Request) {
  try {
    const clientIP = getClientIP(req);

    // Validate Login CSRF token to prevent Login CSRF attacks
    const csrfTokenHeader = req.headers.get('x-login-csrf-token');
    const cookieHeader = req.headers.get('cookie');
    const cookies = parse(cookieHeader || '');
    const csrfTokenCookie = cookies.login_csrf;

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

    const { email, password } = validation.data;

    // Distributed rate limiting
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
    const passwordToCheck = user?.password || '$2a$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewY5GyYzpLLEm4Eu';
    const isValid = await bcrypt.compare(password, passwordToCheck);

    if (!user || !user.password || !isValid) {
      const reason = !user ? 'invalid_email' : 'invalid_password';
      logAuthEvent('failed', user?.id, email, clientIP, reason === 'invalid_email' ? 'Invalid email' : 'Invalid password');
      trackAuthEvent(user?.id, 'failed_login', { reason, email, ip: clientIP });
      return Response.json({ error: 'Invalid email or password' }, { status: 401 });
    }

    // SESSION FIXATION PREVENTION: Revoke all existing sessions before creating new one
    const revokedCount = await sessionService.revokeAllUserSessions(user.id, 'new_login');
    if (revokedCount > 0) {
      loggers.auth.info('Revoked existing sessions on login', { userId: user.id, count: revokedCount });
    }

    // Create new opaque session token
    const sessionToken = await sessionService.createSession({
      userId: user.id,
      type: 'user',
      scopes: ['*'],
      expiresInMs: SESSION_DURATION_MS,
      createdByIp: clientIP !== 'unknown' ? clientIP : undefined,
    });

    // Validate session to get claims for CSRF generation
    const sessionClaims = await sessionService.validateSession(sessionToken);
    if (!sessionClaims) {
      loggers.auth.error('Failed to validate newly created session', { userId: user.id });
      return Response.json({ error: 'Failed to create session.' }, { status: 500 });
    }

    // Generate CSRF token bound to session ID
    const csrfToken = generateCSRFToken(sessionClaims.sessionId);

    // Reset rate limits on successful login
    const resetResults = await Promise.allSettled([
      resetDistributedRateLimit(`login:ip:${clientIP}`),
      resetDistributedRateLimit(`login:email:${email.toLowerCase()}`),
    ]);

    const failures = resetResults.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failures.length > 0) {
      loggers.auth.warn('Rate limit reset failed after successful login', {
        failureCount: failures.length,
        reasons: failures.map(f => f.reason?.message || String(f.reason)),
      });
    }

    logAuthEvent('login', user.id, email, clientIP);
    trackAuthEvent(user.id, 'login', {
      email,
      ip: clientIP,
      userAgent: req.headers.get('user-agent')
    });

    const headers = new Headers();
    appendSessionCookie(headers, sessionToken);
    headers.set('X-RateLimit-Limit', String(DISTRIBUTED_RATE_LIMITS.LOGIN.maxAttempts));
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
      csrfToken,
      ...(redirectTo && { redirectTo }),
    }, { status: 200, headers });

  } catch (error) {
    loggers.auth.error('Login error', error as Error);
    return Response.json({ error: 'An unexpected error occurred.' }, { status: 500 });
  }
}
