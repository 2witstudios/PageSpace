import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import {
  sessionService,
  generateCSRFToken,
  SESSION_DURATION_MS,
  createExchangeCode,
  validateOrCreateDeviceToken,
} from '@pagespace/lib/auth';
import { verifyMagicLinkToken, type DesktopMagicLinkMetadata } from '@pagespace/lib/auth/magic-link-service';
import { markEmailVerified } from '@pagespace/lib/verification-utils';
import { loggers, auditRequest } from '@pagespace/lib/server';
import { trackAuthEvent } from '@pagespace/lib/activity-tracker';
import { getClientIP } from '@/lib/auth';
import { appendSessionCookie } from '@/lib/auth/cookie-config';
import { provisionGettingStartedDriveIfNeeded } from '@/lib/onboarding/getting-started-drive';
import { authRepository } from '@/lib/repositories/auth-repository';

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
      auditRequest(req, {
        eventType: 'auth.login.failure',
        riskScore: 0.3,
        details: { reason: `magic_link_${result.error.code.toLowerCase()}` },
      });

      return redirectWithError(errorCode);
    }

    const { userId, isNewUser, metadata } = result.data;

    // Parse desktop metadata if present (stored when magic link was sent from desktop app)
    let desktopMeta: DesktopMagicLinkMetadata | null = null;
    if (metadata) {
      try {
        const parsed = JSON.parse(metadata) as Partial<DesktopMagicLinkMetadata>;
        if (parsed.platform !== 'desktop' || !parsed.deviceId) {
          desktopMeta = null;
        } else {
          desktopMeta = parsed as DesktopMagicLinkMetadata;
        }
      } catch {
        loggers.auth.warn('Invalid magic link metadata JSON', { userId, metadata: metadata.slice(0, 100) });
      }
    }

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

    // DESKTOP: additionally create device token + exchange code for desktop token handoff
    // The web session (cookies) is always created above — this is a supplementary step.
    // If the magic link opens outside the desktop device, the cookie session still works.
    if (desktopMeta) {
      try {
        const user = await authRepository.findUserById(userId);
        if (user) {
          const { deviceToken } = await validateOrCreateDeviceToken({
            providedDeviceToken: undefined,
            userId,
            deviceId: desktopMeta.deviceId!,
            platform: 'desktop',
            tokenVersion: user.tokenVersion,
            deviceName: desktopMeta.deviceName || req.headers.get('user-agent') || 'Desktop App',
            userAgent: req.headers.get('user-agent') || undefined,
            ipAddress: clientIP !== 'unknown' ? clientIP : undefined,
          });

          const exchangeCode = await createExchangeCode({
            sessionToken,
            csrfToken,
            deviceToken,
            provider: 'magic-link',
            userId,
            createdAt: Date.now(),
          });

          // Redirect to the dashboard with exchange code — the dashboard page
          // will detect this and trigger pagespace://auth-exchange client-side.
          // If the link was opened on a different device, the exchange code is
          // ignored and the user still has a valid cookie session.
          const baseUrl = process.env.WEB_APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
          let desktopRedirectPath = '/dashboard';
          if (isNewUser) {
            try {
              const provisionedDrive = await provisionGettingStartedDriveIfNeeded(userId);
              if (provisionedDrive) {
                desktopRedirectPath = `/dashboard/${provisionedDrive.driveId}`;
              }
            } catch (error) {
              loggers.auth.error('Failed to provision Getting Started drive', error as Error, { userId });
            }
          }
          const desktopRedirectUrl = new URL(desktopRedirectPath, baseUrl);
          desktopRedirectUrl.searchParams.set('auth', 'success');
          desktopRedirectUrl.searchParams.set('desktopExchange', exchangeCode);
          if (isNewUser) {
            desktopRedirectUrl.searchParams.set('welcome', 'true');
          }

          auditRequest(req, {
            eventType: 'auth.login.success',
            userId,
            sessionId: sessionClaims.sessionId,
            details: { method: 'magic_link', platform: 'desktop' },
          });
          trackAuthEvent(userId, 'magic_link_login', {
            ip: clientIP,
            isNewUser,
            platform: 'desktop',
            userAgent: req.headers.get('user-agent'),
          });

          loggers.auth.info('Magic link login successful (desktop)', { userId, ip: clientIP });

          const headers = new Headers();
          appendSessionCookie(headers, sessionToken);
          const isProduction = process.env.NODE_ENV === 'production';
          const secureFlag = isProduction ? '; Secure' : '';
          headers.append('Set-Cookie', `csrf_token=${csrfToken}; Path=/; HttpOnly=false; SameSite=Lax; Max-Age=60${secureFlag}`);

          return NextResponse.redirect(desktopRedirectUrl.toString(), { status: 302, headers });
        }
      } catch (error) {
        loggers.auth.warn('Failed to create desktop exchange for magic link', {
          userId,
          error: error instanceof Error ? error.message : String(error),
        });
        // Fall through to normal web redirect
      }
    }

    // Log auth event
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
    const isProduction = process.env.NODE_ENV === 'production';
    const secureFlag = isProduction ? '; Secure' : '';
    headers.append('Set-Cookie', `csrf_token=${csrfToken}; Path=/; HttpOnly=false; SameSite=Lax; Max-Age=60${secureFlag}`);

    auditRequest(req, {
      eventType: 'auth.login.success',
      userId,
      sessionId: sessionClaims.sessionId,
      details: { method: 'magic_link' },
    });
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
