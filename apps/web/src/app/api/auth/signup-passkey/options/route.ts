import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { generateRegistrationOptionsForSignup } from '@pagespace/lib/auth';
import { loggers, logSecurityEvent } from '@pagespace/lib/server';
import {
  checkDistributedRateLimit,
  DISTRIBUTED_RATE_LIMITS,
} from '@pagespace/lib/security';
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

    // Rate limiting by IP (using signup rate limit)
    const ipRateLimitKey = `signup:ip:${clientIP}`;
    const ipRateLimitResult = await checkDistributedRateLimit(
      ipRateLimitKey,
      DISTRIBUTED_RATE_LIMITS.SIGNUP
    );

    if (!ipRateLimitResult.allowed) {
      logSecurityEvent('passkey_rate_limit_signup_ip', {
        ip: clientIP,
        retryAfter: ipRateLimitResult.retryAfter,
      });
      return NextResponse.json(
        { error: 'Too many requests from this IP', retryAfter: ipRateLimitResult.retryAfter },
        { status: 429 }
      );
    }

    // Parse and validate request body
    const body = await req.json();
    const validation = optionsSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: validation.error.issues },
        { status: 400 }
      );
    }

    const { email, name, csrfToken } = validation.data;
    const normalizedEmail = email.toLowerCase().trim();

    // Rate limiting by email
    const emailRateLimitKey = `signup:email:${normalizedEmail}`;
    const emailRateLimitResult = await checkDistributedRateLimit(
      emailRateLimitKey,
      DISTRIBUTED_RATE_LIMITS.SIGNUP
    );

    if (!emailRateLimitResult.allowed) {
      logSecurityEvent('passkey_rate_limit_signup_email', {
        email: normalizedEmail.substring(0, 3) + '***',
        retryAfter: emailRateLimitResult.retryAfter,
      });
      return NextResponse.json(
        { error: 'Too many signup attempts for this email', retryAfter: emailRateLimitResult.retryAfter },
        { status: 429 }
      );
    }

    // Verify login CSRF token
    if (!validateLoginCSRFToken(csrfToken)) {
      logSecurityEvent('passkey_csrf_invalid', {
        ip: clientIP,
        email: normalizedEmail.substring(0, 3) + '***',
        flow: 'signup_options',
      });
      return NextResponse.json(
        { error: 'Invalid CSRF token' },
        { status: 403 }
      );
    }

    // Generate registration options
    const result = await generateRegistrationOptionsForSignup({ email: normalizedEmail, name });

    if (!result.ok) {
      if (result.error.code === 'EMAIL_EXISTS') {
        loggers.auth.info('Passkey signup - email already exists', {
          ip: clientIP,
          email: normalizedEmail.substring(0, 3) + '***',
        });
        return NextResponse.json(
          { error: 'An account with this email already exists', code: 'EMAIL_EXISTS' },
          { status: 409 }
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
      email: normalizedEmail.substring(0, 3) + '***',
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
