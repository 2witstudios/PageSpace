import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { generateRegistrationOptionsForSignup } from '@pagespace/lib/auth/passkey-service';
import { loggers } from '@pagespace/lib/logging/logger-config'
import { auditRequest } from '@pagespace/lib/audit/audit-log'
import { maskEmail } from '@pagespace/lib/audit/mask-email';
import {
  checkDistributedRateLimit,
  DISTRIBUTED_RATE_LIMITS,
} from '@pagespace/lib/security/distributed-rate-limit';
import { validateLoginCSRFToken, getClientIP } from '@/lib/auth';

const optionsSchema = z.object({
  email: z.email(),
  name: z.string().min(1).max(255),
  csrfToken: z.string().min(1),
});

/**
 * POST /api/auth/signup-passkey/options
 *
 * Generate WebAuthn registration options for new user passkey signup.
 * Public endpoint (unauthenticated) - requires login CSRF token.
 */
export async function POST(req: Request) {
  try {
    const clientIP = getClientIP(req);

    // Parse and validate request body
    const body = await req.json();
    const validation = optionsSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: validation.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    const { email, name, csrfToken } = validation.data;
    const normalizedEmail = email.toLowerCase().trim();

    // Verify login CSRF token BEFORE rate limiting so stale tokens
    // don't burn rate limit attempts (cheap stateless HMAC check)
    if (!validateLoginCSRFToken(csrfToken)) {
      auditRequest(req, {
        eventType: 'security.suspicious.activity',
        riskScore: 0.6,
        details: { reason: 'passkey_csrf_invalid', flow: 'signup_options' },
      });
      return NextResponse.json(
        { error: 'Invalid CSRF token' },
        { status: 403 }
      );
    }

    // Rate limiting by IP (using signup rate limit)
    const ipRateLimitKey = `signup:ip:${clientIP}`;
    const ipRateLimitResult = await checkDistributedRateLimit(
      ipRateLimitKey,
      DISTRIBUTED_RATE_LIMITS.SIGNUP
    );

    if (!ipRateLimitResult.allowed) {
      auditRequest(req, {
        eventType: 'security.rate.limited',
        riskScore: 0.5,
        details: { reason: 'rate_limit_signup_options_ip' },
      });
      return NextResponse.json(
        { error: 'Too many requests from this IP', retryAfter: ipRateLimitResult.retryAfter },
        { status: 429 }
      );
    }

    // Rate limiting by email
    const emailRateLimitKey = `signup:email:${normalizedEmail}`;
    const emailRateLimitResult = await checkDistributedRateLimit(
      emailRateLimitKey,
      DISTRIBUTED_RATE_LIMITS.SIGNUP
    );

    if (!emailRateLimitResult.allowed) {
      auditRequest(req, {
        eventType: 'security.rate.limited',
        riskScore: 0.5,
        details: { reason: 'rate_limit_signup_options_email' },
      });
      return NextResponse.json(
        { error: 'Too many signup attempts for this email', retryAfter: emailRateLimitResult.retryAfter },
        { status: 429 }
      );
    }

    // Generate registration options
    const result = await generateRegistrationOptionsForSignup({ email: normalizedEmail, name });

    if (!result.ok) {
      if (result.error.code === 'EMAIL_EXISTS') {
        loggers.auth.info('Passkey signup - email already exists', {
          ip: clientIP,
          email: maskEmail(normalizedEmail),
        });
        return NextResponse.json(
          { error: 'An account with this email already exists', code: 'EMAIL_EXISTS' },
          { status: 409 }
        );
      }

      if (result.error.code === 'VALIDATION_FAILED') {
        return NextResponse.json(
          { error: 'Invalid data provided', code: 'VALIDATION_FAILED' },
          { status: 400 }
        );
      }

      loggers.auth.warn('Passkey signup options failed', {
        error: result.error.code,
        ip: clientIP,
      });

      return NextResponse.json(
        { error: 'Failed to generate options' },
        { status: 500 }
      );
    }

    loggers.auth.info('Passkey signup options generated', {
      ip: clientIP,
      email: maskEmail(normalizedEmail),
    });

    return NextResponse.json({
      options: result.data.options,
      challengeId: result.data.challengeId,
    }, {
      headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
    });

  } catch (error) {
    loggers.auth.error('Passkey signup options error', error as Error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
