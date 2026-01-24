import { users, userAiSettings, db, eq } from '@pagespace/db';
import bcrypt from 'bcryptjs';
import { z } from 'zod/v4';
import { sessionService } from '@pagespace/lib/auth';
import { createNotification } from '@pagespace/lib/server';
import {
  checkDistributedRateLimit,
  resetDistributedRateLimit,
  DISTRIBUTED_RATE_LIMITS,
} from '@pagespace/lib/security';
import { createId } from '@paralleldrive/cuid2';
import { loggers, logAuthEvent, logSecurityEvent } from '@pagespace/lib/server';
import { trackAuthEvent } from '@pagespace/lib/activity-tracker';
import { parse } from 'cookie';
import { createVerificationToken } from '@pagespace/lib/verification-utils';
import { sendEmail } from '@pagespace/lib/services/email-service';
import { VerificationEmail } from '@pagespace/lib/email-templates/VerificationEmail';
import React from 'react';
import { NextResponse } from 'next/server';
import { provisionGettingStartedDriveIfNeeded } from '@/lib/onboarding/getting-started-drive';
import { validateLoginCSRFToken, getClientIP } from '@/lib/auth';
import { appendSessionCookie } from '@/lib/auth/cookie-config';

const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const signupSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  email: z.email(),
  password: z.string()
    .min(12, 'Password must be at least 12 characters long')
    .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
    .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
    .regex(/[0-9]/, 'Password must contain at least one number'),
  confirmPassword: z.string().min(1, 'Please confirm your password'),
  acceptedTos: z.boolean().refine((val) => val === true, {
    message: 'You must accept the Terms of Service and Privacy Policy',
  }),
}).refine((data) => data.password === data.confirmPassword, {
  message: 'Passwords do not match',
  path: ['confirmPassword'],
});

export async function POST(req: Request) {
  const clientIP = getClientIP(req);
  let email: string | undefined;

  try {
    // Validate Login CSRF token
    const csrfTokenHeader = req.headers.get('x-login-csrf-token');
    const cookieHeader = req.headers.get('cookie');
    const cookies = parse(cookieHeader || '');
    const csrfTokenCookie = cookies.login_csrf;

    if (!csrfTokenHeader || !csrfTokenCookie) {
      logSecurityEvent('signup_csrf_missing', {
        ip: clientIP,
        hasHeader: !!csrfTokenHeader,
        hasCookie: !!csrfTokenCookie,
      });
      return Response.json(
        {
          error: 'Login CSRF token required',
          code: 'LOGIN_CSRF_MISSING',
          details: 'Please refresh the page and try again',
        },
        { status: 403 }
      );
    }

    if (csrfTokenHeader !== csrfTokenCookie) {
      logSecurityEvent('signup_csrf_mismatch', { ip: clientIP });
      return Response.json(
        {
          error: 'Invalid login CSRF token',
          code: 'LOGIN_CSRF_MISMATCH',
          details: 'Please refresh the page and try again',
        },
        { status: 403 }
      );
    }

    if (!validateLoginCSRFToken(csrfTokenHeader)) {
      logSecurityEvent('signup_csrf_invalid', { ip: clientIP });
      return Response.json(
        {
          error: 'Invalid or expired login CSRF token',
          code: 'LOGIN_CSRF_INVALID',
          details: 'Please refresh the page and try again',
        },
        { status: 403 }
      );
    }

    const body = await req.json();
    const validation = signupSchema.safeParse(body);

    if (!validation.success) {
      return Response.json({ errors: validation.error.flatten().fieldErrors }, { status: 400 });
    }

    const { name, email: validatedEmail, password } = validation.data;
    email = validatedEmail;

    // Distributed rate limiting
    const [distributedIpLimit, distributedEmailLimit] = await Promise.all([
      checkDistributedRateLimit(`signup:ip:${clientIP}`, DISTRIBUTED_RATE_LIMITS.SIGNUP),
      checkDistributedRateLimit(`signup:email:${email.toLowerCase()}`, DISTRIBUTED_RATE_LIMITS.SIGNUP),
    ]);

    if (!distributedIpLimit.allowed) {
      logAuthEvent('failed', undefined, email, clientIP, 'IP rate limit exceeded');
      return Response.json(
        {
          error: 'Too many signup attempts from this IP address. Please try again later.',
          retryAfter: distributedIpLimit.retryAfter,
        },
        {
          status: 429,
          headers: {
            'Retry-After': String(distributedIpLimit.retryAfter || 3600),
            'X-RateLimit-Limit': String(DISTRIBUTED_RATE_LIMITS.SIGNUP.maxAttempts),
            'X-RateLimit-Remaining': '0',
          },
        }
      );
    }

    if (!distributedEmailLimit.allowed) {
      logAuthEvent('failed', undefined, email, clientIP, 'Email rate limit exceeded');
      return Response.json(
        {
          error: 'Too many signup attempts for this email. Please try again later.',
          retryAfter: distributedEmailLimit.retryAfter,
        },
        {
          status: 429,
          headers: {
            'Retry-After': String(distributedEmailLimit.retryAfter || 3600),
            'X-RateLimit-Limit': String(DISTRIBUTED_RATE_LIMITS.SIGNUP.maxAttempts),
            'X-RateLimit-Remaining': '0',
          },
        }
      );
    }

    const existingUser = await db.query.users.findFirst({
      where: eq(users.email, email),
    });

    if (existingUser) {
      logAuthEvent('failed', undefined, email, clientIP, 'Email already exists');
      return Response.json({ error: 'User with this email already exists' }, { status: 409 });
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    const user = await db.insert(users).values({
      id: createId(),
      name,
      email,
      password: hashedPassword,
      storageUsedBytes: 0,
      subscriptionTier: 'free',
      tosAcceptedAt: new Date(),
    }).returning().then(res => res[0]);

    let provisionedDrive: { driveId: string } | null = null;
    try {
      provisionedDrive = await provisionGettingStartedDriveIfNeeded(user.id);
    } catch (error) {
      loggers.auth.error('Failed to provision Getting Started drive', error as Error, {
        userId: user.id,
      });
    }

    // Add default 'ollama' provider for the new user
    await db.insert(userAiSettings).values({
      userId: user.id,
      provider: 'ollama',
      baseUrl: 'http://host.docker.internal:11434',
      updatedAt: new Date(),
    });

    logAuthEvent('signup', user.id, email, clientIP);
    loggers.auth.info('New user created', { userId: user.id, email, name });

    // Reset rate limits on successful signup
    const resetResults = await Promise.allSettled([
      resetDistributedRateLimit(`signup:ip:${clientIP}`),
      resetDistributedRateLimit(`signup:email:${email.toLowerCase()}`),
    ]);

    const failures = resetResults.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failures.length > 0) {
      loggers.auth.warn('Rate limit reset failed after successful signup', {
        failureCount: failures.length,
        reasons: failures.map(f => f.reason?.message || String(f.reason)),
      });
    }

    trackAuthEvent(user.id, 'signup', {
      email,
      name,
      ip: clientIP,
      userAgent: req.headers.get('user-agent')
    });

    // Send verification email
    try {
      const verificationToken = await createVerificationToken({
        userId: user.id,
        type: 'email_verification',
      });

      const baseUrl = process.env.WEB_APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
      const verificationUrl = `${baseUrl}/api/auth/verify-email?token=${verificationToken}`;

      await sendEmail({
        to: email,
        subject: 'Verify your PageSpace email',
        react: React.createElement(VerificationEmail, { userName: name, verificationUrl }),
      });

      loggers.auth.info('Verification email sent', { userId: user.id, email });

      await createNotification({
        userId: user.id,
        type: 'EMAIL_VERIFICATION_REQUIRED',
        title: 'Please verify your email',
        message: 'Check your inbox for a verification link. You can resend it from your account settings.',
        metadata: {
          email,
          settingsUrl: '/settings/account',
        },
      });
    } catch (error) {
      loggers.auth.error('Failed to send verification email', error as Error, { userId: user.id });
    }

    // Create session for automatic authentication
    const sessionToken = await sessionService.createSession({
      userId: user.id,
      type: 'user',
      scopes: ['*'],
      expiresInMs: SESSION_DURATION_MS,
      createdByIp: clientIP !== 'unknown' ? clientIP : undefined,
    });

    // Validate session to ensure it was created successfully
    const sessionClaims = await sessionService.validateSession(sessionToken);
    if (!sessionClaims) {
      loggers.auth.error('Failed to validate newly created session', { userId: user.id });
      return Response.json({ error: 'Failed to create session.' }, { status: 500 });
    }

    // Redirect to dashboard
    // Note: CSRF token is NOT passed in URL for security (avoid logging/history exposure)
    // Client should fetch from /api/auth/csrf after redirect completes
    const baseUrl = process.env.NEXTAUTH_URL || process.env.WEB_APP_URL || req.url;
    const dashboardPath = provisionedDrive
      ? `/dashboard/${provisionedDrive.driveId}`
      : '/dashboard';
    const redirectUrl = new URL(dashboardPath, baseUrl);
    redirectUrl.searchParams.set('auth', 'success');

    const headers = new Headers();
    appendSessionCookie(headers, sessionToken);

    return NextResponse.redirect(redirectUrl, {
      status: 303,
      headers
    });
  } catch (error) {
    loggers.auth.error('Signup error', error as Error, { email, clientIP });
    return Response.json({ error: 'An unexpected error occurred.' }, { status: 500 });
  }
}
