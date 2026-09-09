import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { sessionService } from '@pagespace/lib/auth/session-service';
import { generateCSRFToken } from '@pagespace/lib/auth/csrf-utils';
import { SESSION_DURATION_MS } from '@pagespace/lib/auth/constants';
import { createExchangeCode } from '@pagespace/lib/auth/exchange-codes';
import { validateOrCreateDeviceToken } from '@pagespace/lib/auth/device-auth-utils';
import {
  verifyMagicLinkToken,
  type DeviceMagicLinkMetadata,
  type MagicLinkMetadata,
} from '@pagespace/lib/auth/magic-link-service';
import { markEmailVerified } from '@pagespace/lib/auth/verification-utils';
import { userHasPasskey } from '@pagespace/lib/auth/passkey-service';
import { isOnPrem } from '@pagespace/lib/deployment-mode';
import { resetFailedLoginAttempts } from '@pagespace/lib/auth/account-lockout';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { reportAuthFailure } from '@pagespace/lib/security/auth-anomaly-reporter';
import { trackAuthEvent } from '@pagespace/lib/monitoring/activity-tracker';
import { getClientIP, revokeSessionsForLogin } from '@/lib/auth';
import { isSafeNextPath, SIGNIN_NEXT_ALLOWED_PREFIXES } from '@/lib/auth/auth-helpers';
import { appendSessionCookie } from '@/lib/auth/cookie-config';
import { resolveAppUrl } from '@pagespace/lib/services/email-service';
import { provisionHomeDriveIfNeeded } from '@pagespace/lib/onboarding/home-drive';
import { authRepository } from '@/lib/repositories/auth-repository';
import { driveInviteRepository } from '@/lib/repositories/drive-invite-repository';
import {
  consumeAnyInviteIfPresent,
  consumeAllInvitesForEmail,
  type NativeInviteAcceptanceResult,
} from '@/lib/auth/native-invite-acceptance';

/**
 * Magic-link redemption has one core and two doors.
 *
 * - `GET ?token=` is the emailed link for a browser (and the desktop app):
 *   it sets the session cookie and redirects. A desktop-bound link
 *   additionally carries an exchange code for the Electron handoff.
 * - `POST { token }` is called by the in-app page a universal link opens
 *   (`/auth/magic-link/[token]`). It sets the same cookie and answers JSON,
 *   and — only to the device the link was minted for — hands back bearer
 *   tokens for the Keychain, the same shape `/api/auth/{apple,google}/native`
 *   return. The WebView never sees a cookie Safari set, so without this a
 *   magic link cannot sign the app in at all.
 *
 * Everything that grants access lives in `redeemMagicLink`; the doors only
 * shape the response. Device metadata is normalised once into a closed union —
 * a platform the switch does not name gets nothing.
 *
 * Minting a device token is a ROTATION —
 * `atomicValidateOrCreateDeviceToken` overwrites the stored hash of the
 * existing row — so minting on behalf of a device that is not making the
 * request invalidates the credential that device is still holding. A mobile
 * shell must therefore prove it is the redeemer before anything is minted for
 * it: on iOS the Keychain bearer is the only credential it has, so minting at
 * binding time would sign the phone out whenever its own link was opened in a
 * browser — the common case, not the edge case.
 *
 * Desktop is the deliberate exception, unchanged from before this door
 * existed: its handoff has always ridden the emailed GET, so any browser that
 * opens a desktop-bound link rotates that desktop's token. That is a
 * pre-existing wart (the Electron app recovers because it also holds a cookie
 * session), and narrowing it is a separate change from this one — it would
 * alter desktop sign-in, which this PR does not touch.
 */

/** Verification failures, as the codes the doors report to the client. */
const VERIFY_ERROR_CODES: Record<string, string> = {
  TOKEN_EXPIRED: 'magic_link_expired',
  TOKEN_ALREADY_USED: 'magic_link_used',
  TOKEN_NOT_FOUND: 'invalid_token',
  USER_SUSPENDED: 'account_suspended',
  VALIDATION_FAILED: 'invalid_token',
};

const verifyTokenSchema = z.object({
  token: z.string().min(1, 'Token is required'),
});

const redeemBodySchema = z.object({
  token: z.string().min(1, 'Token is required'),
  next: z.string().min(1).max(2048).optional(),
  // The redeeming device's own id. Bearer tokens are released only when it
  // equals the id the link was bound to at mint time.
  deviceId: z.string().min(1).max(200).optional(),
});

/** Which door is redeeming — it decides which handoffs are even possible. */
type Door =
  /** The emailed link, opened in a browser (or by the desktop shell). */
  | { kind: 'browser' }
  /** The in-app page, presenting the device id it holds. */
  | { kind: 'in-app'; presentedDeviceId: string | undefined };

type Handoff =
  | { kind: 'none' }
  | { kind: 'desktop'; deviceId: string; exchangeCode: string }
  | { kind: 'native'; platform: 'ios' | 'android'; deviceId: string; deviceToken: string };

interface PublicUser {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
  emailVerified: Date | null;
}

type RedeemResult =
  | { ok: false; errorCode: string }
  | {
      ok: true;
      userId: string;
      isNewUser: boolean;
      sessionId: string;
      sessionToken: string;
      csrfToken: string;
      /** Where the user lands, before any `?auth=success` decoration. */
      redirectPath: string;
      /** The decoration: invite outcome flags every door appends. */
      redirectParams: Record<string, string>;
      user: PublicUser | null;
      handoff: Handoff;
    };

export async function GET(req: Request) {
  try {
    const clientIP = getClientIP(req);
    const { searchParams } = new URL(req.url);
    const token = searchParams.get('token');
    // Re-validate next at the verify boundary — never trust the param across
    // the email round-trip even though the send route already validated.
    const safeNext = resolveSafeNext(searchParams.get('next'));

    // Validate token format
    const validation = verifyTokenSchema.safeParse({ token });
    if (!validation.success) {
      return redirectWithError('invalid_token', req.url);
    }

    const result = await redeemMagicLink({
      req,
      token: validation.data.token,
      safeNext,
      clientIP,
      door: { kind: 'browser' },
    });
    if (!result.ok) {
      return redirectWithError(result.errorCode, req.url);
    }

    const baseUrl = resolveBaseUrl(req);

    // DESKTOP: the web session (cookies) is always created — this is a
    // supplementary handoff. If the link opens outside the desktop device, the
    // exchange code is ignored and the cookie session still works.
    if (result.handoff.kind === 'desktop') {
      // Redirect to the dashboard with exchange code — the dashboard page
      // will detect this and trigger pagespace://auth-exchange client-side.
      const desktopRedirectUrl = new URL(result.redirectPath, baseUrl);
      desktopRedirectUrl.searchParams.set('auth', 'success');
      desktopRedirectUrl.searchParams.set('desktopExchange', result.handoff.exchangeCode);
      if (result.isNewUser) {
        desktopRedirectUrl.searchParams.set('welcome', 'true');
      }
      applyRedirectParams(desktopRedirectUrl, result.redirectParams);

      recordLoginSuccess({ req, result, clientIP, platform: 'desktop' });
      loggers.auth.info('Magic link login successful (desktop)', { userId: result.userId, ip: clientIP });

      return NextResponse.redirect(desktopRedirectUrl.toString(), {
        status: 302,
        headers: buildSessionHeaders(result),
      });
    }

    const effectiveRedirectPath = await applyPasskeyFunnel(result.userId, result.redirectPath);
    const redirectUrl = new URL(effectiveRedirectPath, baseUrl);
    redirectUrl.searchParams.set('auth', 'success');
    applyRedirectParams(redirectUrl, result.redirectParams);

    recordLoginSuccess({ req, result, clientIP, platform: undefined });
    loggers.auth.info('Magic link login successful', {
      userId: result.userId,
      isNewUser: result.isNewUser,
      ip: clientIP,
    });

    return NextResponse.redirect(redirectUrl.toString(), {
      status: 302,
      headers: buildSessionHeaders(result),
    });
  } catch (error) {
    loggers.auth.error('Magic link verify error', error as Error);
    return redirectWithError('server_error', req.url);
  }
}

/**
 * In-app redemption. Same core as GET; answers JSON so the page that the
 * universal link opened can store the session where the shell reads it.
 */
export async function POST(req: Request) {
  try {
    const clientIP = getClientIP(req);

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: 'invalid_token' }, { status: 400 });
    }
    const validation = redeemBodySchema.safeParse(body);
    if (!validation.success) {
      return Response.json({ error: 'invalid_token' }, { status: 400 });
    }
    const { token, deviceId: presentedDeviceId } = validation.data;
    const safeNext = resolveSafeNext(validation.data.next ?? null);

    const result = await redeemMagicLink({
      req,
      token,
      safeNext,
      clientIP,
      door: { kind: 'in-app', presentedDeviceId },
    });
    if (!result.ok) {
      return Response.json({ error: result.errorCode }, { status: statusForError(result.errorCode) });
    }

    // Bearer tokens exist here only if the core confirmed this device. A
    // laptop browser, a second phone, or a request with no device at all
    // reaches this line with `kind: 'none'` and gets the cookie session
    // alone, exactly like the emailed GET.
    const nativeHandoff = result.handoff.kind === 'native' ? result.handoff : null;

    // Same funnel as GET, on every path through this door — an on-prem user
    // with no passkey needs enrollment whichever client redeemed the link.
    const redirectPath = await applyPasskeyFunnel(result.userId, result.redirectPath);
    // Relative-URL assembly only; the origin is thrown away below.
    const redirectTo = new URL(redirectPath, 'http://placeholder.invalid');
    redirectTo.searchParams.set('auth', 'success');
    if (result.isNewUser) {
      redirectTo.searchParams.set('welcome', 'true');
    }
    applyRedirectParams(redirectTo, result.redirectParams);

    recordLoginSuccess({ req, result, clientIP, platform: nativeHandoff?.platform });
    loggers.auth.info('Magic link login successful (in-app)', {
      userId: result.userId,
      isNewUser: result.isNewUser,
      ip: clientIP,
      platform: nativeHandoff?.platform ?? 'web',
    });

    const headers = buildSessionHeaders(result);
    headers.set('Content-Type', 'application/json');
    return new Response(
      JSON.stringify({
        redirectTo: `${redirectTo.pathname}${redirectTo.search}`,
        isNewUser: result.isNewUser,
        user: result.user,
        ...(nativeHandoff && {
          sessionToken: result.sessionToken,
          csrfToken: result.csrfToken,
          deviceToken: nativeHandoff.deviceToken,
        }),
      }),
      { status: 200, headers },
    );
  } catch (error) {
    loggers.auth.error('Magic link redeem error', error as Error);
    return Response.json({ error: 'server_error' }, { status: 500 });
  }
}

/**
 * Verify the token, sign the user in, and describe what each door may hand
 * out. Every access decision is here; nothing below the switch on
 * `handoffDevice.platform` grants a device anything the switch did not name.
 */
async function redeemMagicLink({
  req,
  token,
  safeNext,
  clientIP,
  door,
}: {
  req: Request;
  token: string;
  safeNext: string | undefined;
  clientIP: string;
  door: Door;
}): Promise<RedeemResult> {
  // Verify the magic link token
  const result = await verifyMagicLinkToken({ token });

  if (!result.ok) {
    const errorCode = VERIFY_ERROR_CODES[result.error.code] || 'invalid_token';
    loggers.auth.warn('Magic link verification failed', {
      error: result.error.code,
      ip: clientIP,
    });
    auditRequest(req, {
      eventType: 'auth.login.failure',
      riskScore: 0.3,
      details: { reason: `magic_link_${result.error.code.toLowerCase()}` },
    });

    // IP-keyed anomaly alerting (#977) — distinct from account lockout. Counts
    // failures per source IP (Postgres-backed) and emits a brute-force/anomaly
    // audit event when one IP crosses the threshold. Fire-and-forget and
    // IP-scoped, so (consistent with the no-self-lockout design above) it can
    // never lock out a legitimate user; it only raises a monitoring signal.
    void reportAuthFailure({
      identifier: clientIP,
      ipAddress: clientIP,
      endpoint: 'magic-link/verify',
    }).catch(() => {
      /* monitoring must never break the auth path */
    });

    return { ok: false, errorCode };
  }

  const { userId, isNewUser, metadata } = result.data;

  // Account-lockout recovery path. A valid, freshly-issued magic link proves
  // the real user requested it, so it ALWAYS signs them in and clears any
  // lock — even one set by failed passkey attempts. This is what makes the
  // lockout safe against a denial-of-service: an attacker can never lock a
  // victim out of their account because the magic-link channel is never
  // blocked. We deliberately do NOT record failed magic-link verifications:
  // a failed token carries no account identity to attribute (only the
  // already-administrative USER_SUSPENDED does), and benign expired/used-link
  // clicks would self-lock legitimate users for zero attacker-facing benefit.
  await resetFailedLoginAttempts(userId);

  // Parse metadata once. The shape carries optional device fields and an
  // optional invite-token binding — device and invite can co-exist on the
  // same row (invited user signing in from the desktop or mobile app).
  let parsedMeta: MagicLinkMetadata | null = null;
  if (metadata) {
    try {
      parsedMeta = JSON.parse(metadata) as MagicLinkMetadata;
    } catch {
      loggers.auth.warn('Invalid magic link metadata JSON', { userId, metadata: metadata.slice(0, 100) });
    }
  }

  const deviceMeta = normalizeDeviceMeta(parsedMeta);
  const handoffDevice = handoffDeviceFor(deviceMeta, door);
  if (deviceMeta && !handoffDevice) {
    loggers.auth.info('Magic link redeemed away from the device it was minted for', {
      userId,
      platform: deviceMeta.platform,
      door: door.kind,
    });
  }
  const boundInviteToken = parsedMeta?.inviteToken;

  // SESSION FIXATION PREVENTION: Revoke prior sessions before creating a new
  // one. Scope to the device only when THIS request is that device; a
  // cross-device email link cannot identify the device, so the helper falls
  // back to the legacy all-web-session revoke. Admin-console sessions are scoped
  // separately and left intact.
  await revokeSessionsForLogin(userId, handoffDevice?.deviceId, 'magic_link_login', 'magic-link');

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
    deviceId: handoffDevice?.deviceId,
    createdByIp: clientIP !== 'unknown' ? clientIP : undefined,
  });

  // Validate session to get claims for CSRF generation
  const sessionClaims = await sessionService.validateSession(sessionToken);
  if (!sessionClaims) {
    loggers.auth.error('Failed to validate newly created session', { userId });
    return { ok: false, errorCode: 'session_error' };
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
  let inviteResult: NativeInviteAcceptanceResult | null = null;
  let inviteError: string | null = null;
  try {
    const status = await driveInviteRepository.findUserVerificationStatusById(userId);
    if (status) {
      if (boundInviteToken) {
        inviteResult = await consumeAnyInviteIfPresent({
          request: req,
          inviteToken: boundInviteToken,
          user: { id: userId, suspendedAt: status.suspendedAt },
          isNewUser,
          email: status.email,
        });
        if (inviteResult.inviteError) {
          inviteError = inviteResult.inviteError;
          loggers.auth.info('Bound invite acceptance failed during magic link verify', {
            userId,
            reason: inviteResult.inviteError,
          });
        }
      }
      await consumeAllInvitesForEmail({
        request: req,
        email: status.email,
        user: { id: userId, suspendedAt: status.suspendedAt },
        now: new Date(),
      });
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
  const invitedDriveId = inviteResult?.invitedDriveId ?? null;

  // Provision the Home drive unconditionally — idempotent, and run BEFORE the
  // redirect branches so every login provisions, including page/connection
  // invite logins whose redirect never consults the shared resolver below.
  // Errors are logged and swallowed: the session is valid, and the next login
  // through any auth path retries provisioning.
  let provisionedDriveId: string | null = null;
  try {
    const provisionResult = await provisionHomeDriveIfNeeded(userId);
    if (provisionResult.created) {
      provisionedDriveId = provisionResult.driveId;
    }
  } catch (error) {
    loggers.auth.error('Failed to provision Home drive', error as Error, { userId });
  }

  // Determine the landing path — kind-specific overrides win, then fall back
  // to the shared helper so new-user provisioning and `next` still work.
  let redirectPath: string;
  if (inviteResult?.kind === 'connection') {
    redirectPath = '/dashboard/connections';
  } else if (inviteResult?.kind === 'page' && invitedDriveId && inviteResult.invitedPageId) {
    redirectPath = `/dashboard/${invitedDriveId}/pages/${inviteResult.invitedPageId}`;
  } else {
    redirectPath = resolvePostLoginRedirectPath({ provisionedDriveId, next: safeNext, invitedDriveId });
  }

  const redirectParams: Record<string, string> = {};
  if (inviteResult?.kind === 'connection') {
    redirectParams.connection_requested = '1';
  } else if (invitedDriveId) {
    redirectParams.invited = '1';
  } else if (inviteError) {
    redirectParams.inviteError = inviteError;
  }

  // DEVICE HANDOFF: mint a device token for the device that is redeeming, and
  // hand it over the way that device collects it — an exchange code for the
  // desktop app, bearer tokens for the mobile shell. Nothing is minted for a
  // device that is not here (see the rotation note at the top of this file).
  // The web session above is always created first; a handoff failure logs and
  // degrades to the cookie session, never to no session.
  let handoff: Handoff = { kind: 'none' };
  let user: PublicUser | null = null;
  if (handoffDevice) {
    try {
      const userRow = await authRepository.findUserById(userId);
      if (userRow) {
        user = {
          id: userRow.id,
          name: userRow.name,
          email: userRow.email,
          image: userRow.image,
          emailVerified: userRow.emailVerified,
        };
        const { deviceToken } = await validateOrCreateDeviceToken({
          providedDeviceToken: undefined,
          userId,
          deviceId: handoffDevice.deviceId,
          platform: handoffDevice.platform,
          tokenVersion: userRow.tokenVersion,
          deviceName:
            handoffDevice.deviceName ||
            req.headers.get('user-agent') ||
            defaultDeviceName(handoffDevice.platform),
          userAgent: req.headers.get('user-agent') || undefined,
          ipAddress: clientIP !== 'unknown' ? clientIP : undefined,
        });

        switch (handoffDevice.platform) {
          case 'desktop': {
            const exchangeCode = await createExchangeCode({
              sessionToken,
              csrfToken,
              deviceToken,
              provider: 'magic-link',
              userId,
              createdAt: Date.now(),
            });
            handoff = { kind: 'desktop', deviceId: handoffDevice.deviceId, exchangeCode };
            break;
          }
          case 'ios':
          case 'android':
            handoff = {
              kind: 'native',
              platform: handoffDevice.platform,
              deviceId: handoffDevice.deviceId,
              deviceToken,
            };
            break;
        }
      }
    } catch (error) {
      loggers.auth.warn('Failed to create device handoff for magic link', {
        userId,
        platform: handoffDevice.platform,
        error: error instanceof Error ? error.message : String(error),
      });
      // Fall through to the cookie session, and do not report a user the
      // caller would read as "fully signed in on this device".
      handoff = { kind: 'none' };
      user = null;
    }
  }

  return {
    ok: true,
    userId,
    isNewUser,
    sessionId: sessionClaims.sessionId,
    sessionToken,
    csrfToken,
    redirectPath,
    redirectParams,
    user,
    handoff,
  };
}

/**
 * The one place a stored platform string becomes a device binding. Anything
 * the switch does not name — a missing platform, a platform this build does
 * not know, a row with no deviceId — is not a device binding at all.
 */
function normalizeDeviceMeta(parsed: MagicLinkMetadata | null): DeviceMagicLinkMetadata | null {
  if (!parsed?.deviceId) return null;
  const deviceName = parsed.deviceName !== undefined ? { deviceName: parsed.deviceName } : {};
  switch (parsed.platform) {
    case 'desktop':
    case 'ios':
    case 'android':
      return { platform: parsed.platform, deviceId: parsed.deviceId, ...deviceName };
    default:
      return null;
  }
}

/**
 * Which device, if any, this request may have a handoff minted for.
 *
 * The one place that decision is made, because minting rotates the stored
 * hash. `null` means no device handoff at all — the redeemer still gets the
 * ordinary cookie session.
 *
 * The two platforms answer it differently, and the difference is the point:
 *
 * - A **mobile shell must prove it is the redeemer**, by presenting the device
 *   id it holds. Nothing is minted for a phone that is not making the request.
 * - **Desktop does not prove anything**, and is eligible on any browser that
 *   opens the emailed link. That is the pre-existing behaviour, kept
 *   deliberately: the exchange code has always ridden the emailed GET. It is
 *   weaker than the mobile rule — see the note at the top of this file.
 *
 * `deviceId` is the mobile proof, so it is load-bearing here in a way it was
 * not before: whoever holds both the magic-link token and the bound device id
 * can obtain that device's bearer tokens. Both come from the same place (the
 * app that requested the link), the token is single-use and short-lived, and
 * no endpoint echoes a device id back to a caller — but a future change that
 * exposed device ids would weaken this, and should reckon with it here.
 */
function handoffDeviceFor(
  deviceMeta: DeviceMagicLinkMetadata | null,
  door: Door,
): DeviceMagicLinkMetadata | null {
  if (!deviceMeta) return null;
  switch (deviceMeta.platform) {
    case 'desktop':
      return door.kind === 'browser' ? deviceMeta : null;
    case 'ios':
    case 'android':
      return door.kind === 'in-app' && door.presentedDeviceId === deviceMeta.deviceId
        ? deviceMeta
        : null;
  }
}

function defaultDeviceName(platform: DeviceMagicLinkMetadata['platform']): string {
  switch (platform) {
    case 'desktop':
      return 'Desktop App';
    case 'ios':
      return 'iOS App';
    case 'android':
      return 'Android App';
  }
}

function resolveSafeNext(rawNext: string | null): string | undefined {
  return rawNext && isSafeNextPath({ path: rawNext, allowedPrefixes: SIGNIN_NEXT_ALLOWED_PREFIXES })
    ? rawNext
    : undefined;
}

function resolveBaseUrl(req: Request): string {
  return process.env.WEB_APP_URL || process.env.NEXT_PUBLIC_APP_URL || new URL(req.url).origin;
}

function applyRedirectParams(url: URL, params: Record<string, string>): void {
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
}

/**
 * On-prem onboarding funnel: a user who just signed in via an admin-issued
 * setup link and has no passkey yet is sent to first-run passkey enrollment
 * (on-prem has no password and no email delivery, so a passkey is their only
 * durable credential). Cloud/tenant are untouched. Enrollment is skippable
 * and forwards to `next`, so this never hard-blocks the user.
 * Wrapped like every other post-session DB call in this handler: the session
 * is already committed, so a transient failure on the passkey lookup must
 * NOT fall through to the outer catch (which returns without the session
 * cookie and bounces the user to signin — fatal on-prem, where there is no
 * other login channel). On error, skip the funnel and use the normal redirect.
 */
async function applyPasskeyFunnel(userId: string, redirectPath: string): Promise<string> {
  try {
    if (isOnPrem() && !(await userHasPasskey(userId))) {
      return `/auth/passkey-setup?next=${encodeURIComponent(redirectPath)}`;
    }
  } catch (error) {
    loggers.auth.error('Passkey enrollment funnel check failed; using normal redirect', error as Error, {
      userId,
    });
  }
  return redirectPath;
}

/**
 * Session cookie plus the short-lived, JS-readable CSRF cookie the client
 * picks up after login (same pattern as the password login route).
 */
function buildSessionHeaders(result: Extract<RedeemResult, { ok: true }>): Headers {
  const headers = new Headers();
  appendSessionCookie(headers, result.sessionToken);
  const isProduction = process.env.NODE_ENV === 'production';
  const secureFlag = isProduction ? '; Secure' : '';
  headers.append('Set-Cookie', `csrf_token=${result.csrfToken}; Path=/; HttpOnly=false; SameSite=Lax; Max-Age=60${secureFlag}`);
  return headers;
}

function recordLoginSuccess({
  req,
  result,
  clientIP,
  platform,
}: {
  req: Request;
  result: Extract<RedeemResult, { ok: true }>;
  clientIP: string;
  platform: DeviceMagicLinkMetadata['platform'] | undefined;
}): void {
  auditRequest(req, {
    eventType: 'auth.login.success',
    userId: result.userId,
    sessionId: result.sessionId,
    details: { method: 'magic_link', ...(platform && { platform }) },
  });
  trackAuthEvent(result.userId, 'magic_link_login', {
    ip: clientIP,
    isNewUser: result.isNewUser,
    ...(platform && { platform }),
    userAgent: req.headers.get('user-agent'),
  });
}

function statusForError(errorCode: string): number {
  switch (errorCode) {
    case 'account_suspended':
      return 403;
    case 'server_error':
    case 'session_error':
      return 500;
    default:
      return 401;
  }
}

function redirectWithError(error: string, requestUrl?: string): NextResponse {
  const baseUrl =
    process.env.WEB_APP_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    (requestUrl ? new URL(requestUrl).origin : resolveAppUrl());
  const redirectUrl = new URL('/auth/signin', baseUrl);
  redirectUrl.searchParams.set('error', error);

  return NextResponse.redirect(redirectUrl.toString(), { status: 302 });
}

/**
 * Resolve the post-login dashboard redirect path. Single source of truth for
 * every door so they cannot drift on the next redirect-rule change. A
 * successfully consumed invite always wins (lands the user on the drive they
 * joined); a pre-validated `next` is the fallback for non-invite flows. Pure
 * on purpose — Home-drive provisioning happens once in `redeemMagicLink`,
 * before any redirect branch.
 */
function resolvePostLoginRedirectPath({
  provisionedDriveId,
  next,
  invitedDriveId,
}: {
  provisionedDriveId: string | null;
  next?: string;
  invitedDriveId?: string | null;
}): string {
  if (invitedDriveId) {
    return `/dashboard/${invitedDriveId}`;
  }

  if (next) {
    return next;
  }

  if (provisionedDriveId) {
    return `/dashboard/${provisionedDriveId}`;
  }

  return '/dashboard';
}
