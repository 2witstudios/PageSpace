import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { verifyRegistration, validateCSRFToken } from '@pagespace/lib/auth';
import { loggers, logSecurityEvent, securityAudit } from '@pagespace/lib/server';
import { trackAuthEvent } from '@pagespace/lib/activity-tracker';
import {
  checkDistributedRateLimit,
  DISTRIBUTED_RATE_LIMITS,
} from '@pagespace/lib/security';
import {
  authenticateSessionRequest,
  isAuthError,
  isSessionAuthResult,
  getClientIP,
} from '@/lib/auth';

const verifySchema = z.object({
  response: z.any(), // WebAuthn response - validated by simplewebauthn
  expectedChallenge: z.string().min(1),
  name: z.string().max(255).optional(),
});

/**
 * POST /api/auth/passkey/register
 *
 * Verify WebAuthn registration response and store the new passkey.
 * Requires session authentication and CSRF token.
 */
export async function POST(req: Request) {
  try {
    const clientIP = getClientIP(req);

    // Verify session auth
    const authResult = await authenticateSessionRequest(req);
    if (isAuthError(authResult)) {
      return authResult.error;
    }

    const userId = authResult.userId;
    const sessionId = isSessionAuthResult(authResult) ? authResult.sessionId : null;

    // Verify CSRF token (skip for Bearer token auth - not vulnerable to CSRF)
    const hasBearerAuth = !!req.headers.get('authorization');
    if (!hasBearerAuth && sessionId) {
      const csrfToken = req.headers.get('x-csrf-token');
      if (!csrfToken || !validateCSRFToken(csrfToken, sessionId)) {
        logSecurityEvent('passkey_csrf_invalid', {
          userId,
          ip: clientIP,
          flow: 'register',
        });
        return NextResponse.json(
          { error: 'Invalid CSRF token' },
          { status: 403 }
        );
      }
    }

    // Rate limiting
    const rateLimitKey = `passkey_register:${userId}`;
    const rateLimitResult = await checkDistributedRateLimit(
      rateLimitKey,
      DISTRIBUTED_RATE_LIMITS.PASSKEY_REGISTER
    );

    if (!rateLimitResult.allowed) {
      logSecurityEvent('passkey_rate_limit_register', {
        userId,
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
        { error: 'Invalid request body', details: validation.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    const { response, expectedChallenge, name } = validation.data;

    // Verify registration
    const result = await verifyRegistration({
      userId,
      response,
      expectedChallenge,
      name,
    });

    if (!result.ok) {
      const errorMap: Record<string, { status: number; message: string }> = {
        'CHALLENGE_NOT_FOUND': { status: 400, message: 'Challenge not found or invalid' },
        'CHALLENGE_EXPIRED': { status: 400, message: 'Challenge expired, please try again' },
        'CHALLENGE_ALREADY_USED': { status: 400, message: 'Challenge already used' },
        'VERIFICATION_FAILED': { status: 400, message: 'Verification failed' },
        'VALIDATION_FAILED': { status: 400, message: 'Validation failed' },
      };

      const errorInfo = errorMap[result.error.code] || { status: 500, message: 'Internal server error' };

      loggers.auth.warn('Passkey registration verification failed', {
        userId,
        error: result.error.code,
        ip: clientIP,
      });

      return NextResponse.json(
        { error: errorInfo.message, code: result.error.code },
        { status: errorInfo.status }
      );
    }

    // Track successful passkey registration
    trackAuthEvent(userId, 'passkey_registered', {
      ip: clientIP,
      passkeyId: result.data.passkeyId,
      passkeyName: name,
      userAgent: req.headers.get('user-agent'),
    });

    loggers.auth.info('Passkey registered successfully', {
      userId,
      passkeyId: result.data.passkeyId,
      ip: clientIP,
    });
    securityAudit.logTokenCreated(userId, 'passkey', clientIP).catch((error) => {
      loggers.security.warn('[PasskeyRegister] audit logTokenCreated failed', { error: error instanceof Error ? error.message : String(error), userId });
    });

    return NextResponse.json({
      success: true,
      passkeyId: result.data.passkeyId,
    }, {
      headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
    });

  } catch (error) {
    loggers.auth.error('Passkey registration verification error', error as Error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
