import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import {
  sessionService,
  generateCSRFToken,
  SESSION_DURATION_MS,
} from '@pagespace/lib/auth';
import { verifyMagicLinkToken } from '@pagespace/lib/auth/magic-link-service';
import { markEmailVerified } from '@pagespace/lib/verification-utils';
import { loggers, logAuthEvent } from '@pagespace/lib/server';
import { trackAuthEvent } from '@pagespace/lib/activity-tracker';
import { getClientIP } from '@/lib/auth';
import { appendSessionCookie } from '@/lib/auth/cookie-config';
import { provisionGettingStartedDriveIfNeeded } from '@/lib/onboarding/getting-started-drive';

const verifyTokenSchema = z.object({
  token: z.string().min(1, 'Token is required'),
});

export async function GET(req: Request) {
  try {
    const clientIP = getClientIP(req);
    const { searchParams } = new URL(req.url);
    const token = searchParams.get('token');

    // Validate token format
    const validation = verifyTokenSchema.safeParse({ token });
    if (!validation.success) {
      return redirectWithError('invalid_token');
    }

    // Verify the magic link token
    const result = await verifyMagicLinkToken({ token: validation.data.token });

    if (!result.ok) {
      const errorMap: Record<string, string> = {
        'TOKEN_EXPIRED': 'magic_link_expired',
        'TOKEN_ALREADY_USED': 'magic_link_used',
        'TOKEN_NOT_FOUND': 'invalid_token',
        'USER_SUSPENDED': 'account_suspended',
        'VALIDATION_FAILED': 'invalid_token',
      };

      const errorCode = errorMap[result.error.code] || 'invalid_token';
      loggers.auth.warn('Magic link verification failed', {
        error: result.error.code,
        ip: clientIP,
      });

      return redirectWithError(errorCode);
    }

    const { userId, isNewUser } = result.data;

    // SESSION FIXATION PREVENTION: Revoke all existing sessions before creating new one
    const revokedCount = await sessionService.revokeAllUserSessions(userId, 'magic_link_login');
    if (revokedCount > 0) {
      loggers.auth.info('Revoked existing sessions on magic link login', {
        userId,
        count: revokedCount,
      });
    }

    // Mark email as verified (idempotent for existing users)
    try {
      await markEmailVerified(userId);
    } catch (error) {
      loggers.auth.error('Failed to mark email as verified', error as Error, { userId });
      // Continue with login anyway - email verification is secondary
    }

    // Create new session
    const sessionToken = await sessionService.createSession({
      userId,
      type: 'user',
      scopes: ['*'],
      expiresInMs: SESSION_DURATION_MS,
      createdByIp: clientIP !== 'unknown' ? clientIP : undefined,
    });

    // Validate session to get claims for CSRF generation
    const sessionClaims = await sessionService.validateSession(sessionToken);
    if (!sessionClaims) {
      loggers.auth.error('Failed to validate newly created session', { userId });
      return redirectWithError('session_error');
    }

    // Generate CSRF token bound to session ID
    const csrfToken = generateCSRFToken(sessionClaims.sessionId);

    // Log auth event
    logAuthEvent('magic_link_login', userId, undefined, clientIP);
    trackAuthEvent(userId, 'magic_link_login', {
      ip: clientIP,
      isNewUser,
      userAgent: req.headers.get('user-agent'),
    });

    // Build response headers with session cookie
    const headers = new Headers();
    appendSessionCookie(headers, sessionToken);

    // Determine redirect URL
    let redirectPath = '/dashboard';

    // For new users, provision getting started drive if needed
    if (isNewUser) {
      try {
        const provisionedDrive = await provisionGettingStartedDriveIfNeeded(userId);
        if (provisionedDrive) {
          redirectPath = `/dashboard/${provisionedDrive.driveId}`;
        }
      } catch (error) {
        loggers.auth.error('Failed to provision Getting Started drive', error as Error, {
          userId,
        });
        // Continue with default dashboard redirect
      }
    }

    const baseUrl = process.env.WEB_APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    const redirectUrl = new URL(redirectPath, baseUrl);
    redirectUrl.searchParams.set('auth', 'success');

    // Store CSRF token in a temporary cookie for the client to retrieve
    // This follows the pattern from login - client-side JS will read and store this
    headers.append('Set-Cookie', `csrf_token=${csrfToken}; Path=/; HttpOnly=false; SameSite=Lax; Max-Age=60`);

    loggers.auth.info('Magic link login successful', {
      userId,
      isNewUser,
      ip: clientIP,
    });

    return NextResponse.redirect(redirectUrl.toString(), {
      status: 302,
      headers,
    });

  } catch (error) {
    loggers.auth.error('Magic link verify error', error as Error);
    return redirectWithError('server_error');
  }
}

function redirectWithError(error: string): NextResponse {
  const baseUrl = process.env.WEB_APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  const redirectUrl = new URL('/auth/signin', baseUrl);
  redirectUrl.searchParams.set('error', error);

  return NextResponse.redirect(redirectUrl.toString(), { status: 302 });
}
