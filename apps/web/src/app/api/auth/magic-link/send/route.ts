import { z } from 'zod/v4';
import { parse } from 'cookie';
import {
  checkDistributedRateLimit,
  DISTRIBUTED_RATE_LIMITS,
} from '@pagespace/lib/security/distributed-rate-limit';
import { requestMagicLink } from '@pagespace/lib/services/invites';
import { buildMagicLinkPorts } from '@/lib/auth/magic-link-adapters';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { maskEmail } from '@pagespace/lib/audit/mask-email';
import { secureCompare } from '@pagespace/lib/auth/secure-compare';
import { validateLoginCSRFToken, getClientIP } from '@/lib/auth';

const sendMagicLinkSchema = z.object({
  email: z.email({ message: 'Please enter a valid email address' }),
  platform: z.enum(['web', 'desktop']).optional(),
  deviceId: z.string().optional(),
  deviceName: z.string().optional(),
}).refine(
  (data) => data.platform !== 'desktop' || (data.deviceId && data.deviceName),
  { message: 'deviceId and deviceName are required for desktop platform' }
);

export async function POST(req: Request) {
  try {
    const clientIP = getClientIP(req);

    // Validate Login CSRF token to prevent CSRF attacks
    const csrfTokenHeader = req.headers.get('x-login-csrf-token');
    const cookieHeader = req.headers.get('cookie');
    const cookies = parse(cookieHeader || '');
    const csrfTokenCookie = cookies.login_csrf;

    if (!csrfTokenHeader || !csrfTokenCookie) {
      auditRequest(req, {
        eventType: 'security.suspicious.activity',
        riskScore: 0.4,
        details: { reason: 'magic_link_csrf_missing', hasHeader: !!csrfTokenHeader, hasCookie: !!csrfTokenCookie },
      });
      return Response.json(
        {
          error: 'CSRF token required',
          code: 'LOGIN_CSRF_MISSING',
          details: 'Please refresh the page and try again',
        },
        { status: 403 }
      );
    }

    if (!secureCompare(csrfTokenHeader, csrfTokenCookie)) {
      auditRequest(req, {
        eventType: 'security.suspicious.activity',
        riskScore: 0.6,
        details: { reason: 'magic_link_csrf_mismatch' },
      });
      return Response.json(
        {
          error: 'Invalid CSRF token',
          code: 'LOGIN_CSRF_MISMATCH',
          details: 'Please refresh the page and try again',
        },
        { status: 403 }
      );
    }

    if (!validateLoginCSRFToken(csrfTokenHeader)) {
      auditRequest(req, {
        eventType: 'security.suspicious.activity',
        riskScore: 0.6,
        details: { reason: 'magic_link_csrf_invalid' },
      });
      return Response.json(
        {
          error: 'Invalid or expired CSRF token',
          code: 'LOGIN_CSRF_INVALID',
          details: 'Please refresh the page and try again',
        },
        { status: 403 }
      );
    }

    // Validate request body
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json(
        { error: 'Invalid request body' },
        { status: 400 }
      );
    }
    const validation = sendMagicLinkSchema.safeParse(body);

    if (!validation.success) {
      return Response.json(
        { errors: validation.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    const { email, platform, deviceId, deviceName } = validation.data;
    const normalizedEmail = email.toLowerCase().trim();

    // Rate limit by IP and email
    const [ipRateLimit, emailRateLimit] = await Promise.all([
      checkDistributedRateLimit(`magic_link:ip:${clientIP}`, DISTRIBUTED_RATE_LIMITS.MAGIC_LINK),
      checkDistributedRateLimit(`magic_link:email:${normalizedEmail}`, DISTRIBUTED_RATE_LIMITS.MAGIC_LINK),
    ]);

    if (!ipRateLimit.allowed) {
      auditRequest(req, {
        eventType: 'security.rate.limited',
        riskScore: 0.5,
        details: { reason: 'magic_link_rate_limit_ip' },
      });
      return Response.json(
        {
          error: 'Too many requests. Please try again later.',
          retryAfter: ipRateLimit.retryAfter,
        },
        {
          status: 429,
          headers: {
            'Retry-After': String(ipRateLimit.retryAfter || 900),
            'X-RateLimit-Limit': String(DISTRIBUTED_RATE_LIMITS.MAGIC_LINK.maxAttempts),
            'X-RateLimit-Remaining': '0',
          },
        }
      );
    }

    if (!emailRateLimit.allowed) {
      auditRequest(req, {
        eventType: 'security.rate.limited',
        riskScore: 0.5,
        details: { reason: 'magic_link_rate_limit_email' },
      });
      return Response.json(
        {
          error: 'Too many requests for this email. Please try again later.',
          retryAfter: emailRateLimit.retryAfter,
        },
        {
          status: 429,
          headers: {
            'Retry-After': String(emailRateLimit.retryAfter || 900),
            'X-RateLimit-Limit': String(DISTRIBUTED_RATE_LIMITS.MAGIC_LINK.maxAttempts),
            'X-RateLimit-Remaining': '0',
          },
        }
      );
    }

    // requestMagicLink pipe owns the full flow: load user → validate (no-auto-
    // create / not-suspended) → mint token → send email. On any failure mode
    // the pipe never minted a token nor sent an email.
    let result;
    try {
      result = await requestMagicLink(buildMagicLinkPorts())({
        email: normalizedEmail,
        now: new Date(),
        ...(platform && { platform }),
        ...(deviceId && { deviceId }),
        ...(deviceName && { deviceName }),
      });
    } catch (error) {
      // Email send (or any other adapter throw) failed AFTER the pipe minted
      // a token. Log + return generic success: a 5xx here would distinguish
      // "this email exists" from "doesn't exist" by triggering only on
      // existing accounts, defeating the rate-limited enumeration resistance.
      loggers.auth.error('Magic link pipe threw', error as Error, {
        email: maskEmail(normalizedEmail),
      });
      return Response.json({
        message: 'If an account exists with this email, we have sent a sign-in link.',
      });
    }

    if (!result.ok) {
      if (result.error === 'ACCOUNT_SUSPENDED') {
        auditRequest(req, {
          eventType: 'auth.login.failure',
          riskScore: 0.5,
          details: { reason: 'magic_link_user_suspended' },
        });
        // Generic success masks suspension state from the requester.
        return Response.json({
          message: 'If an account exists with this email, we have sent a sign-in link.',
        });
      }

      // NO_ACCOUNT_FOUND is surfaced explicitly (trade enumeration-resistance
      // for a clearer signup path). MagicLinkForm consumes the structured
      // payload and renders the "Sign up instead" CTA pre-filled with the
      // entered email.
      if (result.error === 'NO_ACCOUNT_FOUND') {
        auditRequest(req, {
          eventType: 'auth.login.failure',
          riskScore: 0.2,
          details: { reason: 'magic_link_no_account_found' },
        });
        return Response.json(
          { code: 'no_account', email: normalizedEmail },
          { status: 404 },
        );
      }

      // VALIDATION_FAILED from the pipe shouldn't reach here — we zod-
      // validated upstream — but stay defensive. Wrap the string code in an
      // Error so the entry.error structured field populates the same way the
      // earlier error log on this handler does.
      loggers.auth.error(
        'Magic link pipe returned unexpected error',
        new Error(`MagicLinkErrorCode: ${result.error}`),
      );
      return Response.json({
        message: 'If an account exists with this email, we have sent a sign-in link.',
      });
    }

    // Pipe succeeded: token minted + email sent inside the adapter.
    loggers.auth.info('Magic link email sent', {
      email: maskEmail(normalizedEmail),
      ip: clientIP,
    });
    auditRequest(req, {
      eventType: 'auth.token.created',
      details: {
        tokenType: 'magic_link',
      },
    });

    return Response.json({
      message: 'If an account exists with this email, we have sent a sign-in link.',
    });

  } catch (error) {
    loggers.auth.error('Magic link send error', error as Error);
    return Response.json(
      { error: 'An unexpected error occurred.' },
      { status: 500 }
    );
  }
}
