import { NextResponse } from 'next/server';
import {
  generateRegistrationOptions,
  validateCSRFToken,
  peekPasskeyRegisterHandoff,
} from '@pagespace/lib/auth';
import { loggers, auditRequest } from '@pagespace/lib/server';
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

async function readOptionalJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const text = await req.text();
    if (!text) return {};
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * POST /api/auth/passkey/register/options
 *
 * Generate WebAuthn registration options for adding a passkey to an account.
 *
 * Two auth modes:
 * - Session: `authenticateSessionRequest` + CSRF header.
 * - Desktop handoff: `{ handoffToken }` in body — peek (non-destructive) so
 *   the verify step still finds a live token. Bypasses session + CSRF; the
 *   handoff token IS the capability, minted against a session and TTL-bound.
 */
export async function POST(req: Request) {
  try {
    const clientIP = getClientIP(req);
    const body = await readOptionalJson(req);
    const handoffToken =
      typeof body.handoffToken === 'string' ? body.handoffToken : null;

    let userId: string;

    if (handoffToken) {
      const peeked = await peekPasskeyRegisterHandoff(handoffToken);
      if (!peeked) {
        auditRequest(req, {
          eventType: 'security.suspicious.activity',
          riskScore: 0.6,
          details: { reason: 'passkey_handoff_invalid', flow: 'register_options' },
        });
        return NextResponse.json(
          { error: 'Invalid or expired handoff token', code: 'HANDOFF_INVALID' },
          { status: 401 }
        );
      }
      userId = peeked.userId;
    } else {
      const authResult = await authenticateSessionRequest(req);
      if (isAuthError(authResult)) {
        return authResult.error;
      }

      userId = authResult.userId;
      const sessionId = isSessionAuthResult(authResult) ? authResult.sessionId : null;

      const hasBearerAuth = !!req.headers.get('authorization');
      if (!hasBearerAuth && sessionId) {
        const csrfToken = req.headers.get('x-csrf-token');
        if (!csrfToken || !validateCSRFToken(csrfToken, sessionId)) {
          auditRequest(req, {
            eventType: 'security.suspicious.activity',
            userId,
            riskScore: 0.6,
            details: { reason: 'passkey_csrf_invalid', flow: 'register_options' },
          });
          return NextResponse.json(
            { error: 'Invalid CSRF token' },
            { status: 403 }
          );
        }
      }
    }

    const rateLimitKey = `passkey_register:${userId}`;
    const rateLimitResult = await checkDistributedRateLimit(
      rateLimitKey,
      DISTRIBUTED_RATE_LIMITS.PASSKEY_REGISTER
    );

    if (!rateLimitResult.allowed) {
      auditRequest(req, {
        eventType: 'security.rate.limited',
        userId,
        riskScore: 0.5,
        details: { reason: 'passkey_rate_limit_register' },
      });
      return NextResponse.json(
        { error: 'Too many requests', retryAfter: rateLimitResult.retryAfter },
        { status: 429 }
      );
    }

    const result = await generateRegistrationOptions({ userId });

    if (!result.ok) {
      const errorMap: Record<string, { status: number; message: string }> = {
        'USER_NOT_FOUND': { status: 404, message: 'User not found' },
        'USER_SUSPENDED': { status: 403, message: 'Account suspended' },
        'MAX_PASSKEYS_REACHED': { status: 400, message: 'Maximum passkeys limit reached' },
        'VALIDATION_FAILED': { status: 400, message: 'Validation failed' },
      };

      const errorInfo = errorMap[result.error.code] || { status: 500, message: 'Internal server error' };

      loggers.auth.warn('Passkey registration options failed', {
        userId,
        error: result.error.code,
        ip: clientIP,
      });

      return NextResponse.json(
        { error: errorInfo.message, code: result.error.code },
        { status: errorInfo.status }
      );
    }

    loggers.auth.info('Passkey registration options generated', {
      userId,
      ip: clientIP,
    });

    return NextResponse.json({
      options: result.data.options,
    }, {
      headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
    });

  } catch (error) {
    loggers.auth.error('Passkey registration options error', error as Error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
