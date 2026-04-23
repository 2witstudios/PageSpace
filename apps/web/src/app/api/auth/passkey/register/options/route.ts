import { NextResponse } from 'next/server';
import { generateRegistrationOptions } from '@pagespace/lib/auth/passkey-service'
import { validateCSRFToken } from '@pagespace/lib/auth/csrf-utils'
import { peekPasskeyRegisterHandoff, markPasskeyRegisterOptionsIssued } from '@pagespace/lib/auth/passkey-register-handoff';
import { loggers } from '@pagespace/lib/logging/logger-config'
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import {
  checkDistributedRateLimit,
  DISTRIBUTED_RATE_LIMITS,
} from '@pagespace/lib/security/distributed-rate-limit';
import {
  authenticateSessionRequest,
  getBearerToken,
  isAuthError,
  isSessionAuthResult,
  getClientIP,
} from '@/lib/auth';

/**
 * Reads the request body as a JSON object. Empty bodies resolve to `{}` so
 * unauthenticated/session callers without a body still reach the session-auth
 * path. Non-object JSON (null, arrays, primitives) is normalized to `{}`.
 * Malformed JSON surfaces as a SyntaxError so the caller can return a
 * controlled 400 — swallowing it would hide client errors and let bad input
 * accidentally engage the session path.
 */
async function readOptionalJson(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (!text) return {};
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
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

    let body: Record<string, unknown>;
    try {
      body = await readOptionalJson(req);
    } catch {
      return NextResponse.json(
        { error: 'Invalid request body' },
        { status: 400 }
      );
    }
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

      const issued = await markPasskeyRegisterOptionsIssued(handoffToken);
      if (!issued) {
        auditRequest(req, {
          eventType: 'security.suspicious.activity',
          userId,
          riskScore: 0.6,
          details: {
            reason: 'passkey_handoff_options_replayed',
            flow: 'register_options',
          },
        });
        return NextResponse.json(
          {
            error: 'Registration options already issued for this handoff',
            code: 'OPTIONS_ALREADY_ISSUED',
          },
          { status: 401 }
        );
      }
    } else {
      const authResult = await authenticateSessionRequest(req);
      if (isAuthError(authResult)) {
        return authResult.error;
      }

      userId = authResult.userId;
      const sessionId = isSessionAuthResult(authResult) ? authResult.sessionId : null;

      const hasBearerAuth = !!getBearerToken(req);
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
