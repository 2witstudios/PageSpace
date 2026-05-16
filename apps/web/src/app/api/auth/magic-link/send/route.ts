import { z } from 'zod/v4';
import { parse } from 'cookie';
import {
  checkDistributedRateLimit,
  DISTRIBUTED_RATE_LIMITS,
} from '@pagespace/lib/security/distributed-rate-limit';
import { isEmailMatch, requestMagicLink } from '@pagespace/lib/services/invites';
import { buildMagicLinkPorts } from '@/lib/auth/magic-link-adapters';
import { resolveInviteContext } from '@/lib/auth/invite-resolver';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { maskEmail } from '@pagespace/lib/audit/mask-email';
import { secureCompare } from '@pagespace/lib/auth/secure-compare';
import { validateLoginCSRFToken, getClientIP } from '@/lib/auth';
import { isSafeNextPath, SIGNIN_NEXT_ALLOWED_PREFIXES } from '@/lib/auth/auth-helpers';
import { INVITE_TOKEN_MAX_LENGTH } from '@/lib/auth/oauth-state';
import { authRepository } from '@/lib/repositories/auth-repository';
import { isAtUserLimit } from '@/lib/user-limit';

const sendMagicLinkSchema = z.object({
  email: z.email({ message: 'Please enter a valid email address' }),
  platform: z.enum(['web', 'desktop']).optional(),
  deviceId: z.string().optional(),
  deviceName: z.string().optional(),
  next: z.string().min(1).max(2048).optional(),
  inviteToken: z.string().min(1).max(INVITE_TOKEN_MAX_LENGTH).optional(),
  tosAccepted: z.boolean(),
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

    const { email, platform, deviceId, deviceName, next, inviteToken, tosAccepted } =
      validation.data;
    const normalizedEmail = email.toLowerCase().trim();

    // Defense in depth: the form's submit button is gated on the checkbox,
    // but a tampered POST body must not bypass affirmative consent. Without
    // tosAccepted we won't auto-create, and refusing here keeps the failure
    // mode loud + auditable instead of silently sending a link.
    if (tosAccepted !== true) {
      auditRequest(req, {
        eventType: 'security.suspicious.activity',
        riskScore: 0.3,
        details: { reason: 'magic_link_tos_not_accepted' },
      });
      return Response.json(
        { code: 'tos_required', error: 'Terms of Service must be accepted' },
        { status: 400 },
      );
    }

    // Re-validate next against the same allowlist the signin page uses. Defense
    // in depth: form already validated, but never trust the client across a
    // boundary. Unsafe values fall through to the default (no next forwarded).
    const safeNext =
      next && isSafeNextPath({ path: next, allowedPrefixes: SIGNIN_NEXT_ALLOWED_PREFIXES })
        ? next
        : undefined;

    // Rate limit by IP and email BEFORE doing any DB work — invite resolution
    // hits pending_invites + users, so allowing it pre-rate-limit lets an
    // attacker amplify load by spamming /send with invite-token guesses.
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

    // Validate inviteToken AFTER rate-limit checks so over-limit requests
    // never reach pending_invites / users. Two gates protect against stolen-
    // token replay: the invite must exist + not be consumed + not be expired
    // AND its email must match the address we're emailing. A mismatch (or any
    // failure) drops the inviteToken silently — we still send the magic link
    // so an attacker who guesses someone else's invite token can't enumerate
    // which addresses it belongs to. The user just signs in normally; the
    // invite stays pending.
    let safeInviteToken: string | undefined;
    if (inviteToken) {
      try {
        const resolution = await resolveInviteContext({ token: inviteToken, now: new Date() });
        if (
          resolution.ok &&
          isEmailMatch({ inviteEmail: resolution.data.email, userEmail: normalizedEmail })
        ) {
          safeInviteToken = inviteToken;
        } else {
          loggers.auth.info('Magic link invite binding rejected', {
            email: maskEmail(normalizedEmail),
            reason: resolution.ok ? 'EMAIL_MISMATCH' : resolution.error,
          });
        }
      } catch (error) {
        loggers.auth.warn('Invite resolution threw during magic link send', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Gate new signups when user limit is active. Existing users (re-signing in)
    // always bypass. Invite holders also bypass via safeInviteToken.
    if (!safeInviteToken) {
      const existingUser = await authRepository.findUserByEmail(normalizedEmail);
      if (!existingUser && await isAtUserLimit()) {
        return Response.json(
          { code: 'user_limit_reached', error: 'Registration is currently at capacity.' },
          { status: 403 },
        );
      }
    }

    let result;
    try {
      result = await requestMagicLink(buildMagicLinkPorts())({
        email: normalizedEmail,
        now: new Date(),
        tosAccepted,
        ...(platform && { platform }),
        ...(deviceId && { deviceId }),
        ...(deviceName && { deviceName }),
        ...(safeNext && { next: safeNext }),
        ...(safeInviteToken && { inviteToken: safeInviteToken }),
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

      // TOS_REQUIRED and VALIDATION_FAILED are upstream-impossible (the schema
      // and the explicit tosAccepted guard above catch them first); surface as
      // a generic 200 to preserve enumeration resistance.
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
