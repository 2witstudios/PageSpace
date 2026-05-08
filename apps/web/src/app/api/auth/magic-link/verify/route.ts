import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { sessionService } from '@pagespace/lib/auth/session-service';
import { generateCSRFToken } from '@pagespace/lib/auth/csrf-utils';
import { SESSION_DURATION_MS } from '@pagespace/lib/auth/constants';
import { createExchangeCode } from '@pagespace/lib/auth/exchange-codes';
import { validateOrCreateDeviceToken } from '@pagespace/lib/auth/device-auth-utils';
import {
  verifyMagicLinkToken,
  type DesktopMagicLinkMetadata,
  type MagicLinkMetadata,
} from '@pagespace/lib/auth/magic-link-service';
import { markEmailVerified } from '@pagespace/lib/auth/verification-utils';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { trackAuthEvent } from '@pagespace/lib/monitoring/activity-tracker';
import { getClientIP } from '@/lib/auth';
import { isSafeNextPath, SIGNIN_NEXT_ALLOWED_PREFIXES } from '@/lib/auth/auth-helpers';
import { appendSessionCookie } from '@/lib/auth/cookie-config';
import { provisionGettingStartedDriveIfNeeded } from '@/lib/onboarding/getting-started-drive';
import { authRepository } from '@/lib/repositories/auth-repository';
import { driveInviteRepository } from '@/lib/repositories/drive-invite-repository';
import { consumeInviteIfPresent } from '@/lib/auth/native-invite-acceptance';

const verifyTokenSchema = z.object({
  token: z.string().min(1, 'Token is required'),
});

export async function GET(req: Request) {
  try {
    const clientIP = getClientIP(req);
    const { searchParams } = new URL(req.url);
    const token = searchParams.get('token');
    // Re-validate next at the verify boundary — never trust the param across
    // the email round-trip even though the send route already validated.
    const rawNext = searchParams.get('next');
    const safeNext =
      rawNext && isSafeNextPath({ path: rawNext, allowedPrefixes: SIGNIN_NEXT_ALLOWED_PREFIXES })
        ? rawNext
        : undefined;

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

    // Parse metadata once. The shape carries optional desktop fields and an
    // optional invite-token binding — desktop and invite can co-exist on the
    // same row (invited user signing in from desktop).
    let parsedMeta: MagicLinkMetadata | null = null;
    if (metadata) {
      try {
        parsedMeta = JSON.parse(metadata) as MagicLinkMetadata;
      } catch {
        loggers.auth.warn('Invalid magic link metadata JSON', { userId, metadata: metadata.slice(0, 100) });
      }
    }

    let desktopMeta: DesktopMagicLinkMetadata | null = null;
    if (parsedMeta && parsedMeta.platform === 'desktop' && parsedMeta.deviceId) {
      desktopMeta = {
        platform: 'desktop',
        deviceId: parsedMeta.deviceId,
        ...(parsedMeta.deviceName !== undefined && { deviceName: parsedMeta.deviceName }),
      };
    }
    const boundInviteToken = parsedMeta?.inviteToken;

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
      deviceId: desktopMeta?.deviceId,
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

    // Consume the invite atomically with authentication. The invite token was
    // bound to the magic-link at mint time, validated against this email +
    // pending-invite state then. We re-load the user's verification status
    // here because the pipe needs the authoritative email + suspendedAt for
    // the second validation gate inside acceptInviteForExistingUser.
    //
    // Wrapped in try/catch: the session is already committed; a DB blip on
    // the verification-status lookup must not redirect the user to signin
    // when they already hold a valid session. Worst case the invite stays
    // pending and the user reclaims it from the consent page.
    let invitedDriveId: string | null = null;
    let inviteError: string | null = null;
    if (boundInviteToken) {
      try {
        const status = await driveInviteRepository.findUserVerificationStatusById(userId);
        if (status) {
          const inviteResult = await consumeInviteIfPresent({
            request: req,
            inviteToken: boundInviteToken,
            user: { id: userId, suspendedAt: status.suspendedAt },
            isNewUser,
            email: status.email,
          });
          invitedDriveId = inviteResult.invitedDriveId;
          if (inviteResult.inviteError) {
            inviteError = inviteResult.inviteError;
            loggers.auth.info('Bound invite acceptance failed during magic link verify', {
              userId,
              reason: inviteResult.inviteError,
            });
          }
        } else {
          loggers.auth.warn('Authenticated session has no user record on invite consume', {
            userId,
          });
        }
      } catch (error) {
        loggers.auth.error('Invite consume threw during magic link verify', error as Error, {
          userId,
        });
        // Continue with login — the session is valid; user can re-attempt invite.
      }
    }

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
          const desktopRedirectPath = await resolvePostLoginRedirectPath({
            isNewUser,
            userId,
            next: safeNext,
            invitedDriveId,
          });
          const desktopRedirectUrl = new URL(desktopRedirectPath, baseUrl);
          desktopRedirectUrl.searchParams.set('auth', 'success');
          desktopRedirectUrl.searchParams.set('desktopExchange', exchangeCode);
          if (isNewUser) {
            desktopRedirectUrl.searchParams.set('welcome', 'true');
          }
          if (invitedDriveId) {
            desktopRedirectUrl.searchParams.set('invited', '1');
          } else if (inviteError) {
            desktopRedirectUrl.searchParams.set('inviteError', inviteError);
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

    // Determine redirect URL via the shared helper so the desktop and web
    // post-login flows cannot drift on the next redirect-rule change.
    const redirectPath = await resolvePostLoginRedirectPath({
      isNewUser,
      userId,
      next: safeNext,
      invitedDriveId,
    });

    const baseUrl = process.env.WEB_APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    const redirectUrl = new URL(redirectPath, baseUrl);
    redirectUrl.searchParams.set('auth', 'success');
    if (invitedDriveId) {
      redirectUrl.searchParams.set('invited', '1');
    } else if (inviteError) {
      redirectUrl.searchParams.set('inviteError', inviteError);
    }

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

/**
 * Resolve the post-login dashboard redirect path. Single source of truth for
 * both the desktop exchange and web cookie flows so the two paths cannot drift
 * out of sync on the next redirect-rule change. A successfully consumed invite
 * always wins (lands the user on the drive they joined); a pre-validated
 * `next` is the fallback for non-invite flows. Provisioning errors are logged
 * and swallowed — the user still lands on /dashboard.
 */
async function resolvePostLoginRedirectPath({
  isNewUser,
  userId,
  next,
  invitedDriveId,
}: {
  isNewUser: boolean;
  userId: string;
  next?: string;
  invitedDriveId?: string | null;
}): Promise<string> {
  if (invitedDriveId) {
    return `/dashboard/${invitedDriveId}`;
  }

  if (next) {
    return next;
  }

  if (!isNewUser) {
    return '/dashboard';
  }

  try {
    const provisionedDrive = await provisionGettingStartedDriveIfNeeded(userId);
    if (provisionedDrive) {
      return `/dashboard/${provisionedDrive.driveId}`;
    }
  } catch (error) {
    loggers.auth.error('Failed to provision Getting Started drive', error as Error, { userId });
  }

  return '/dashboard';
}
