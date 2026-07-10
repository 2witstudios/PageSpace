import { NextResponse } from 'next/server';
import { sendVerificationEmail } from '@/lib/auth/send-verification-email';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { maskEmail } from '@pagespace/lib/audit/mask-email';
import { checkDistributedRateLimit, DISTRIBUTED_RATE_LIMITS } from '@pagespace/lib/security/distributed-rate-limit';
import { authRepository } from '@/lib/repositories/auth-repository';
import { authenticateRequestWithOptions } from '@/lib/auth/request-auth';
import { isAuthError } from '@/lib/auth/auth-core';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

export async function POST(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) {
      return auth.error;
    }

    // Fetch user details from database
    const user = await authRepository.findUserById(auth.userId);

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // Rate limit by email address to prevent email bombing
    const rateLimitResult = await checkDistributedRateLimit(
      `email-resend:${user.email.toLowerCase()}`,
      DISTRIBUTED_RATE_LIMITS.EMAIL_RESEND
    );

    if (!rateLimitResult.allowed) {
      loggers.auth.warn('Email resend rate limit exceeded', { email: maskEmail(user.email) });
      return NextResponse.json(
        { error: 'Too many verification emails requested. Please try again later.' },
        {
          status: 429,
          headers: {
            'Retry-After': String(rateLimitResult.retryAfter || 3600),
          },
        }
      );
    }

    // Check if email is already verified
    if (user.emailVerified) {
      return NextResponse.json(
        { error: 'Email is already verified' },
        { status: 400 }
      );
    }

    // Send verification email (token bound to the user's current address;
    // sendEmail applies its own per-address rate limit).
    try {
      await sendVerificationEmail({
        userId: user.id,
        email: user.email,
        userName: user.name,
      });

      loggers.auth.info('Verification email resent', { userId: user.id, email: maskEmail(user.email) });
      auditRequest(request, { eventType: 'data.write', userId: auth.userId, resourceType: 'email_verification', resourceId: auth.userId });

      return NextResponse.json({
        message: 'Verification email sent successfully. Please check your inbox.'
      });
    } catch (error) {
      // Check if it's a rate limit error
      if (error instanceof Error && error.message.includes('Too many emails')) {
        return NextResponse.json(
          { error: error.message },
          { status: 429 }
        );
      }
      throw error;
    }
  } catch (error) {
    loggers.auth.error('Error resending verification email', error as Error);
    return NextResponse.json(
      { error: 'Failed to send verification email' },
      { status: 500 }
    );
  }
}
