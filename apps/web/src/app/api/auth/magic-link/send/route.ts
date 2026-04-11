import { z } from 'zod/v4';
import { parse } from 'cookie';
import React from 'react';
import {
  checkDistributedRateLimit,
  DISTRIBUTED_RATE_LIMITS,
} from '@pagespace/lib/security';
import { createMagicLinkToken } from '@pagespace/lib/auth/magic-link-service';
import { sendEmail } from '@pagespace/lib/services/email-service';
import { MagicLinkEmail } from '@pagespace/lib/email-templates/MagicLinkEmail';
import { loggers, logSecurityEvent, securityAudit } from '@pagespace/lib/server';
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

/** Mask email to prevent PII in logs (e.g., john@example.com -> jo***@example.com) */
function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '***@***';
  const visibleChars = Math.min(2, local.length);
  return `${local.slice(0, visibleChars)}***@${domain}`;
}

export async function POST(req: Request) {
  try {
    const clientIP = getClientIP(req);

    // Validate Login CSRF token to prevent CSRF attacks
    const csrfTokenHeader = req.headers.get('x-login-csrf-token');
    const cookieHeader = req.headers.get('cookie');
    const cookies = parse(cookieHeader || '');
    const csrfTokenCookie = cookies.login_csrf;

    if (!csrfTokenHeader || !csrfTokenCookie) {
      logSecurityEvent('magic_link_csrf_missing', {
        ip: clientIP,
        hasHeader: !!csrfTokenHeader,
        hasCookie: !!csrfTokenCookie,
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

    if (csrfTokenHeader !== csrfTokenCookie) {
      logSecurityEvent('magic_link_csrf_mismatch', { ip: clientIP });
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
      logSecurityEvent('magic_link_csrf_invalid', { ip: clientIP });
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
      logSecurityEvent('magic_link_rate_limit_ip', { ip: clientIP });
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
      logSecurityEvent('magic_link_rate_limit_email', { email: maskEmail(normalizedEmail), ip: clientIP });
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

    // Create magic link token (handles both existing and new users)
    // Pass platform/deviceId so the verify route can redirect desktop apps via deep link
    const result = await createMagicLinkToken({
      email: normalizedEmail,
      ...(platform && { platform }),
      ...(deviceId && { deviceId }),
      ...(deviceName && { deviceName }),
    });

    // SECURITY: Always return same response to prevent email enumeration
    // Even if user is suspended, we return success but don't send email
    if (!result.ok) {
      if (result.error.code === 'USER_SUSPENDED') {
        logSecurityEvent('magic_link_suspended_user', { email: maskEmail(normalizedEmail), ip: clientIP });
        // Return success to prevent enumeration, but don't send email
        return Response.json({
          message: 'If an account exists with this email, we have sent a sign-in link.',
        });
      }

      // Validation errors are safe to return
      if (result.error.code === 'VALIDATION_FAILED') {
        return Response.json(
          { error: result.error.message },
          { status: 400 }
        );
      }

      // For other errors, log and return generic success
      loggers.auth.error('Magic link creation failed', { error: result.error });
      return Response.json({
        message: 'If an account exists with this email, we have sent a sign-in link.',
      });
    }

    // Send magic link email
    const baseUrl = process.env.WEB_APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    const magicLinkUrl = `${baseUrl}/api/auth/magic-link/verify?token=${result.data.token}`;

    try {
      await sendEmail({
        to: normalizedEmail,
        subject: 'Sign in to PageSpace',
        react: React.createElement(MagicLinkEmail, { magicLinkUrl }),
      });

      loggers.auth.info('Magic link email sent', {
        email: maskEmail(normalizedEmail),
        isNewUser: result.data.isNewUser,
        ip: clientIP,
      });
      securityAudit.logEvent({
        eventType: 'data.write',
        resourceType: 'magic_link',
        resourceId: 'magic_link_request',
        ipAddress: clientIP,
      }).catch((error) => {
        loggers.security.warn('[MagicLinkSend] audit logEvent failed', { error: error instanceof Error ? error.message : String(error) });
      });
    } catch (error) {
      // Log but don't expose email sending errors
      loggers.auth.error('Failed to send magic link email', error as Error, {
        email: maskEmail(normalizedEmail),
      });
    }

    // Always return same success message to prevent enumeration
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
