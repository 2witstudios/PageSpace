import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { oauthRepository } from '@/lib/repositories/oauth-repository';
import {
  verifySignupRegistration,
  sessionService,
  generateCSRFToken,
  SESSION_DURATION_MS,
} from '@pagespace/lib/auth';
import { loggers, logAuthEvent, logSecurityEvent } from '@pagespace/lib/server';
import { trackAuthEvent } from '@pagespace/lib/activity-tracker';
import {
  checkDistributedRateLimit,
  resetDistributedRateLimit,
  DISTRIBUTED_RATE_LIMITS,
} from '@pagespace/lib/security';
import { validateLoginCSRFToken, getClientIP, createDeviceToken } from '@/lib/auth';
import { appendSessionCookie } from '@/lib/auth/cookie-config';
import { provisionGettingStartedDriveIfNeeded, type ProvisionGettingStartedDriveResult } from '@/lib/onboarding/getting-started-drive';

const verifySchema = z.object({
  email: z.email(),
  name: z.string().min(1).max(255),
  response: z.any(), // WebAuthn response - validated by simplewebauthn
  expectedChallenge: z.string().min(1),
  csrfToken: z.string().min(1),
  passkeyName: z.string().max(255).optional(),
  acceptedTos: z.boolean().refine((val) => val === true, {
    message: 'You must accept the Terms of Service',
  }),
  platform: z.enum(['web', 'desktop']).optional().default('web'),
  deviceId: z.string().optional(),
  deviceName: z.string().optional(),
});

/**
 * POST /api/auth/signup-passkey
 *
 * Verify WebAuthn registration response, create user, and create a session.
 * Public endpoint (unauthenticated) - requires login CSRF token.
 */
export async function POST(req: Request) {
  const clientIP = getClientIP(req);
  let email: string | undefined;

  try {
    // Parse and validate request body
    const body = await req.json();
    const validation = verifySchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: validation.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    const { email: validatedEmail, name, response, expectedChallenge, csrfToken, passkeyName, acceptedTos } = validation.data;
    email = validatedEmail.toLowerCase().trim();

    // Verify login CSRF token BEFORE rate limiting so stale tokens
    // don't burn rate limit attempts (cheap stateless HMAC check)
    if (!validateLoginCSRFToken(csrfToken)) {
      logSecurityEvent('passkey_csrf_invalid', {
        ip: clientIP,
        email: email.substring(0, 3) + '***',
        flow: 'signup',
      });
      return NextResponse.json(
        { error: 'Invalid CSRF token' },
        { status: 403 }
      );
    }

    // Rate limiting by IP
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

    // Rate limiting by email
    const emailRateLimitKey = `signup:email:${email}`;
    const emailRateLimitResult = await checkDistributedRateLimit(
      emailRateLimitKey,
      DISTRIBUTED_RATE_LIMITS.SIGNUP
    );

    if (!emailRateLimitResult.allowed) {
      logSecurityEvent('passkey_rate_limit_signup_email', {
        email: email.substring(0, 3) + '***',
        retryAfter: emailRateLimitResult.retryAfter,
      });
      return NextResponse.json(
        { error: 'Too many signup attempts for this email', retryAfter: emailRateLimitResult.retryAfter },
        { status: 429 }
      );
    }

    // Verify registration and create user
    const result = await verifySignupRegistration({
      email,
      name,
      response,
      expectedChallenge,
      passkeyName,
      acceptedTos,
    });

    if (!result.ok) {
      const errorMap: Record<string, { status: number; message: string }> = {
        'EMAIL_EXISTS': { status: 409, message: 'An account with this email already exists' },
        'CHALLENGE_NOT_FOUND': { status: 400, message: 'Challenge not found or invalid' },
        'CHALLENGE_EXPIRED': { status: 400, message: 'Challenge expired, please try again' },
        'CHALLENGE_ALREADY_USED': { status: 400, message: 'Challenge already used' },
        'VERIFICATION_FAILED': { status: 400, message: 'Passkey verification failed' },
        'VALIDATION_FAILED': { status: 400, message: 'Invalid data provided' },
      };

      const errorInfo = errorMap[result.error.code] || { status: 500, message: 'Internal server error' };

      loggers.auth.warn('Passkey signup failed', {
        error: result.error.code,
        ip: clientIP,
        email: email.substring(0, 3) + '***',
      });

      return NextResponse.json(
        { error: errorInfo.message, code: result.error.code },
        { status: errorInfo.status }
      );
    }

    const { userId, passkeyId } = result.data;

    // Provision getting started drive for new user
    let provisionedDrive: ProvisionGettingStartedDriveResult | null = null;
    try {
      provisionedDrive = await provisionGettingStartedDriveIfNeeded(userId);
    } catch (error) {
      loggers.auth.error('Failed to provision Getting Started drive', error as Error, {
        userId,
      });
    }

    // Add default 'ollama' provider for the new user
    try {
      await oauthRepository.createDefaultAiSettings(userId);
    } catch (error) {
      loggers.auth.error('Failed to insert default AI settings', error as Error, { userId });
    }

    // Log auth events
    logAuthEvent('signup', userId, email, clientIP);
    loggers.auth.info('Passkey signup successful', { userId, email: email.substring(0, 3) + '***', name });

    // Reset rate limits on successful signup
    await Promise.allSettled([
      resetDistributedRateLimit(ipRateLimitKey),
      resetDistributedRateLimit(emailRateLimitKey),
    ]);

    // Track signup event (using 'signup' + passkey_registered for full event tracking)
    // Mask PII to comply with data retention policies
    const maskedEmail = email.substring(0, 3) + '***@' + (email.split('@')[1] || '***');
    const maskedName = name.substring(0, 1) + '***';
    trackAuthEvent(userId, 'signup', {
      email: maskedEmail,
      name: maskedName,
      ip: clientIP,
      userAgent: req.headers.get('user-agent'),
      method: 'passkey',
    });
    trackAuthEvent(userId, 'passkey_registered', {
      passkeyId,
      ip: clientIP,
    });

    const { platform, deviceId, deviceName: deviceNameField } = validation.data;

    // Create session
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

    let deviceTokenValue: string | undefined;
    if (deviceId) {
      try {
        deviceTokenValue = await createDeviceToken({
          userId, deviceId,
          tokenVersion: 1, // verifySignupRegistration creates users with tokenVersion: 1
          platform: platform || 'web',
          deviceName: deviceNameField || req.headers.get('user-agent') || (platform === 'desktop' ? 'Desktop App' : 'Web Browser'),
          userAgent: req.headers.get('user-agent') || undefined,
          ipAddress: clientIP !== 'unknown' ? clientIP : undefined,
        });
      } catch (error) {
        loggers.auth.warn('Failed to create device token', {
          userId, error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    loggers.auth.info('Passkey signup session created', {
      userId,
      ip: clientIP,
    });

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

    // Determine redirect URL
    const dashboardPath = provisionedDrive
      ? `/dashboard/${provisionedDrive.driveId}`
      : '/dashboard';

    return NextResponse.json(
      {
        success: true,
        userId,
        redirectUrl: `${dashboardPath}?welcome=true`,
        sessionToken,
        csrfToken: newCsrfToken,
        ...(deviceTokenValue && { deviceToken: deviceTokenValue }),
      },
      { headers }
    );

  } catch (error) {
    loggers.auth.error('Passkey signup verification error', error as Error, { email, clientIP });
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
