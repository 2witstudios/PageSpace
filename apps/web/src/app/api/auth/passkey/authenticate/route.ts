import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import {
  verifyAuthentication,
  sessionService,
  generateCSRFToken,
  SESSION_DURATION_MS,
} from '@pagespace/lib/auth';
import { loggers, logSecurityEvent } from '@pagespace/lib/server';
import { trackAuthEvent } from '@pagespace/lib/activity-tracker';
import {
  checkDistributedRateLimit,
  resetDistributedRateLimit,
  DISTRIBUTED_RATE_LIMITS,
} from '@pagespace/lib/security';
import { validateLoginCSRFToken, getClientIP } from '@/lib/auth';
import { appendSessionCookie } from '@/lib/auth/cookie-config';

const verifySchema = z.object({
  response: z.any(), // WebAuthn response - validated by simplewebauthn
  expectedChallenge: z.string().min(1),
  csrfToken: z.string().min(1),
});

/**
 * POST /api/auth/passkey/authenticate
 *
 * Verify WebAuthn authentication response and create a session.
 * Public endpoint (unauthenticated) - requires login CSRF token.
 */
export async function POST(req: Request) {
  try {
    const clientIP = getClientIP(req);

    // Rate limiting by IP
    const rateLimitKey = `passkey_auth:${clientIP}`;
    const rateLimitResult = await checkDistributedRateLimit(
      rateLimitKey,
      DISTRIBUTED_RATE_LIMITS.PASSKEY_AUTH
    );

    if (!rateLimitResult.allowed) {
      logSecurityEvent('passkey_rate_limit_auth', {
        ip: clientIP,
        retryAfter: rateLimitResult.retryAfter,
      });
      return NextResponse.json(
        { error: 'Too many requests', retryAfter: rateLimitResult.retryAfter },
        { status: 429 }
      );
    }

    // Parse and validate request body
    const body = await req.json();
    const validation = verifySchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: validation.error.issues },
        { status: 400 }
      );
    }

    const { response, expectedChallenge, csrfToken } = validation.data;

    // Verify login CSRF token
    if (!validateLoginCSRFToken(csrfToken)) {
      logSecurityEvent('passkey_csrf_invalid', {
        ip: clientIP,
        flow: 'authenticate',
      });
      return NextResponse.json(
        { error: 'Invalid CSRF token' },
        { status: 403 }
      );
    }

    // Verify authentication
    const result = await verifyAuthentication({
      response,
      expectedChallenge,
    });

    if (!result.ok) {
      const errorMap: Record<string, { status: number; message: string }> = {
        'CREDENTIAL_NOT_FOUND': { status: 400, message: 'Passkey not found' },
        'CHALLENGE_NOT_FOUND': { status: 400, message: 'Challenge not found or invalid' },
        'CHALLENGE_EXPIRED': { status: 400, message: 'Challenge expired, please try again' },
        'CHALLENGE_ALREADY_USED': { status: 400, message: 'Challenge already used' },
        'VERIFICATION_FAILED': { status: 400, message: 'Verification failed' },
        'USER_SUSPENDED': { status: 403, message: 'Account suspended' },
        'COUNTER_REPLAY_DETECTED': { status: 400, message: 'Security error: credential replay detected' },
      };

      const errorInfo = errorMap[result.error.code] || { status: 500, message: 'Internal server error' };

      loggers.auth.warn('Passkey authentication failed', {
        error: result.error.code,
        ip: clientIP,
      });

      return NextResponse.json(
        { error: errorInfo.message, code: result.error.code },
        { status: errorInfo.status }
      );
    }

    const { userId } = result.data;

    // SESSION FIXATION PREVENTION: Revoke all existing sessions before creating new one
    const revokedCount = await sessionService.revokeAllUserSessions(userId, 'passkey_login');
    if (revokedCount > 0) {
      loggers.auth.info('Revoked existing sessions on passkey login', {
        userId,
        count: revokedCount,
      });
    }

    // Create new session
    const sessionToken = await sessionService.createSession({
      userId,
      type: 'user',
      scopes: ['*'],
      expiresInMs: SESSION_DURATION_MS,
      createdByIp: clientIP !== 'unknown' ? clientIP : undefined,
    });

    // Validate session to get claims for CSRF generation
    const sessionClaims = await sessionService.validateSession(sessionToken);
    if (!sessionClaims) {
      loggers.auth.error('Failed to validate newly created session', { userId });
      return NextResponse.json(
        { error: 'Session creation failed' },
        { status: 500 }
      );
    }

    // Generate CSRF token bound to session ID
    const newCsrfToken = generateCSRFToken(sessionClaims.sessionId);

    // Reset rate limit on successful login
    await resetDistributedRateLimit(rateLimitKey);

    // Track successful passkey login
    trackAuthEvent(userId, 'passkey_login', {
      ip: clientIP,
      userAgent: req.headers.get('user-agent'),
    });

    loggers.auth.info('Passkey login successful', {
      userId,
      ip: clientIP,
    });

    // Build response headers with session cookie
    const headers = new Headers();
    headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    appendSessionCookie(headers, sessionToken);

    // Add CSRF token cookie for client to retrieve
    const isProduction = process.env.NODE_ENV === 'production';
    const secureFlag = isProduction ? '; Secure' : '';
    headers.append(
      'Set-Cookie',
      `csrf_token=${newCsrfToken}; Path=/; HttpOnly=false; SameSite=Lax; Max-Age=60${secureFlag}`
    );

    return NextResponse.json(
      {
        success: true,
        userId,
        redirectUrl: '/dashboard',
      },
      { headers }
    );

  } catch (error) {
    loggers.auth.error('Passkey auth verification error', error as Error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
