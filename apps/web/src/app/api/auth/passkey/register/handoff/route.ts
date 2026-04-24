import { NextResponse } from 'next/server';
import { createPasskeyRegisterHandoff } from '@pagespace/lib/auth/passkey-register-handoff';
import { validateCSRFToken } from '@pagespace/lib/auth/csrf-utils';
import { loggers } from '@pagespace/lib/logging/logger-config';
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
} from '@/lib/auth';

const HANDOFF_TTL_SECONDS = 300;

/**
 * POST /api/auth/passkey/register/handoff
 *
 * Mint a short-lived, one-time handoff token the Electron renderer can pass
 * to the system browser so the external passkey-register page can drive the
 * WebAuthn ceremony without a PageSpace session cookie. Authenticated and
 * CSRF-protected; uses the same per-user passkey_register rate limit bucket
 * as the register routes so a handoff token cannot escape its bounds.
 */
export async function POST(req: Request) {
  try {
    const authResult = await authenticateSessionRequest(req);
    if (isAuthError(authResult)) {
      return authResult.error;
    }

    const userId = authResult.userId;
    const sessionId = isSessionAuthResult(authResult) ? authResult.sessionId : null;

    const hasBearerAuth = !!getBearerToken(req);
    if (!hasBearerAuth && sessionId) {
      const csrfToken = req.headers.get('x-csrf-token');
      if (!csrfToken || !validateCSRFToken(csrfToken, sessionId)) {
        auditRequest(req, {
          eventType: 'security.suspicious.activity',
          userId,
          riskScore: 0.6,
          details: { reason: 'passkey_csrf_invalid', flow: 'register_handoff' },
        });
        return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 });
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

    const handoffToken = await createPasskeyRegisterHandoff({ userId });

    auditRequest(req, {
      eventType: 'auth.token.created',
      userId,
      details: { tokenType: 'passkey_register_handoff' },
    });

    loggers.auth.info('Passkey register handoff minted', { userId });

    return NextResponse.json(
      { handoffToken, expiresIn: HANDOFF_TTL_SECONDS },
      { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } }
    );
  } catch (error) {
    loggers.auth.error('Passkey register handoff error', error as Error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
