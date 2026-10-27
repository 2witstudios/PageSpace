import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { generateAuthenticationOptions } from '@pagespace/lib/auth/passkey-service';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import {
  checkDistributedRateLimit,
  DISTRIBUTED_RATE_LIMITS,
} from '@pagespace/lib/security/distributed-rate-limit';
import { validateLoginCSRFToken, getClientIP } from '@/lib/auth';

const optionsSchema = z.object({
  email: z.string().email().optional(),
  csrfToken: z.string().min(1),
});

/**
 * POST /api/auth/passkey/authenticate/options
 *
 * Generate WebAuthn authentication options for passkey login.
 * Public endpoint (unauthenticated) - requires login CSRF token.
 * Email is optional - if provided, filters allowCredentials to that user's passkeys.
 */
export async function POST(req: Request) {
  try {
    const clientIP = getClientIP(req);

    // Rate limiting by IP
    const rateLimitKey = `passkey_options:${clientIP}`;
    const rateLimitResult = await checkDistributedRateLimit(
      rateLimitKey,
      DISTRIBUTED_RATE_LIMITS.PASSKEY_OPTIONS
    );

    if (!rateLimitResult.allowed) {
      auditRequest(req, {
        eventType: 'security.rate.limited',
        riskScore: 0.5,
        details: { reason: 'passkey_rate_limit_options' },
      });
      return NextResponse.json(
        { error: 'Too many requests', retryAfter: rateLimitResult.retryAfter },
        { status: 429 }
      );
    }

    // Parse and validate request body
    const body = await req.json();
    const validation = optionsSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: validation.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    const { email, csrfToken } = validation.data;

    // Verify login CSRF token
    if (!validateLoginCSRFToken(csrfToken)) {
      auditRequest(req, {
        eventType: 'security.suspicious.activity',
        riskScore: 0.6,
        details: { reason: 'passkey_csrf_invalid', flow: 'authenticate_options' },
      });
      return NextResponse.json(
        { error: 'Invalid CSRF token' },
        { status: 403 }
      );
    }

    // Generate authentication options
    const result = await generateAuthenticationOptions({ email });

    if (!result.ok) {
      loggers.auth.warn('Passkey auth options failed', {
        error: result.error.code,
        ip: clientIP,
      });

      return NextResponse.json(
        { error: 'Failed to generate options' },
        { status: 500 }
      );
    }

    loggers.auth.info('Passkey auth options generated', {
      ip: clientIP,
      hasEmail: !!email,
    });

    return NextResponse.json({
      options: result.data.options,
      challengeId: result.data.challengeId,
    }, {
      headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
    });

  } catch (error) {
    loggers.auth.error('Passkey auth options error', error as Error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
