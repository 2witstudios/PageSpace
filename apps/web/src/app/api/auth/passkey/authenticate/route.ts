import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { verifyAuthentication } from '@pagespace/lib/auth/passkey-service'
import { sessionService } from '@pagespace/lib/auth/session-service'
import { generateCSRFToken } from '@pagespace/lib/auth/csrf-utils'
import { createExchangeCode } from '@pagespace/lib/auth/exchange-codes'
import { SESSION_DURATION_MS } from '@pagespace/lib/auth/constants';
import { loggers } from '@pagespace/lib/logging/logger-config'
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { trackAuthEvent } from '@pagespace/lib/monitoring/activity-tracker';
import {
  checkDistributedRateLimit,
  resetDistributedRateLimit,
  DISTRIBUTED_RATE_LIMITS,
} from '@pagespace/lib/security/distributed-rate-limit';
import { validateLoginCSRFToken, getClientIP, createDeviceToken } from '@/lib/auth';
import { appendSessionCookie } from '@/lib/auth/cookie-config';
import { authRepository } from '@/lib/repositories/auth-repository';

const verifySchema = z.object({
  response: z.any(), // WebAuthn response - validated by simplewebauthn
  expectedChallenge: z.string().min(1),
  csrfToken: z.string().min(1),
  platform: z.enum(['web', 'desktop']).optional().default('web'),
  deviceId: z.string().max(128).optional(),
  deviceName: z.string().max(256).optional(),
  desktopExchange: z.boolean().optional().default(false),
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
      auditRequest(req, {
        eventType: 'security.rate.limited',
        riskScore: 0.5,
        details: { reason: 'passkey_rate_limit_auth' },
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

    const { response, expectedChallenge, csrfToken, platform, deviceId, deviceName, desktopExchange } = validation.data;

    if (desktopExchange && !deviceId) {
      return NextResponse.json(
        { error: 'deviceId is required for desktop exchange handoff' },
        { status: 400 }
      );
    }

    if (desktopExchange && platform !== 'desktop') {
      return NextResponse.json(
        { error: 'desktopExchange requires platform: desktop' },
        { status: 400 }
      );
    }

    // Desktop auth must go through the external-browser exchange flow. The
    // legacy path that returned a raw sessionToken in the response body for
    // platform=desktop is removed — it's dead code after #1001 and leaking
    // raw tokens in JSON is strictly worse than the opaque exchange code.
    if (platform === 'desktop' && !desktopExchange) {
      return NextResponse.json(
        { error: 'platform=desktop requires desktopExchange=true' },
        { status: 400 }
      );
    }

    // Verify login CSRF token
    if (!validateLoginCSRFToken(csrfToken)) {
      auditRequest(req, {
        eventType: 'security.suspicious.activity',
        riskScore: 0.6,
        details: { reason: 'passkey_csrf_invalid', flow: 'authenticate' },
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
      auditRequest(req, {
        eventType: 'auth.login.failure',
        riskScore: 0.3,
        details: { reason: `passkey_auth_${result.error.code.toLowerCase()}` },
      });

      return NextResponse.json(
        { error: errorInfo.message, code: result.error.code },
        { status: errorInfo.status }
      );
    }

    const { userId } = result.data;

    // Passkey is the strongest auth flow — hard-reset all sessions across devices
    const revokedCount = await sessionService.revokeAllUserSessions(userId, 'passkey_login');
    if (revokedCount > 0) {
      loggers.auth.info('Revoked all sessions on passkey login', { userId, count: revokedCount });
    }

    // Create new session
    const sessionToken = await sessionService.createSession({
      userId,
      type: 'user',
      scopes: ['*'],
      expiresInMs: SESSION_DURATION_MS,
      deviceId,
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
    auditRequest(req, {
      eventType: 'auth.login.success',
      userId,
      sessionId: sessionClaims.sessionId,
      details: { method: 'passkey' },
    });

    let deviceTokenValue: string | undefined;
    if (deviceId) {
      try {
        const user = await authRepository.findUserById(userId);
        if (user) {
          deviceTokenValue = await createDeviceToken({
            userId, deviceId, tokenVersion: user.tokenVersion,
            platform: platform || 'web',
            deviceName: deviceName || req.headers.get('user-agent') || (platform === 'desktop' ? 'Desktop App' : 'Web Browser'),
            userAgent: req.headers.get('user-agent') || undefined,
            ipAddress: clientIP !== 'unknown' ? clientIP : undefined,
          });
        }
      } catch (error) {
        loggers.auth.warn('Failed to create device token', {
          userId, error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (desktopExchange) {
      if (!deviceTokenValue) {
        loggers.auth.error('Desktop exchange requested but device token missing', { userId });
        return NextResponse.json(
          { error: 'Failed to create device token for desktop exchange' },
          { status: 500 }
        );
      }

      const code = await createExchangeCode({
        sessionToken,
        csrfToken: newCsrfToken,
        deviceToken: deviceTokenValue,
        provider: 'passkey',
        userId,
        createdAt: Date.now(),
      });

      loggers.auth.info('Desktop passkey exchange mint', { userId, provider: 'passkey' });

      return NextResponse.json(
        {
          success: true,
          userId,
          redirectUrl: '/dashboard',
          desktopExchangeCode: code,
        },
        {
          headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
        }
      );
    }

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
        csrfToken: newCsrfToken,
        ...(deviceTokenValue && { deviceToken: deviceTokenValue }),
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
