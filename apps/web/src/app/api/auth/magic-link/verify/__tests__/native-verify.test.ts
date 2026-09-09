/**
 * Tests for the in-app door: POST /api/auth/magic-link/verify, and how GET
 * treats a link that was minted for the iOS / Android shell.
 *
 * A native-bound link always creates the cookie session. Bearer tokens for the
 * Keychain are released only to the device the link was bound to — proven by
 * the presented deviceId — so a browser opening the same link, or the wrong
 * device, gets a cookie and nothing more.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('next/server', () => ({
  NextResponse: {
    redirect: vi.fn((url: string, init?: { status?: number; headers?: Headers }) => {
      const headers = init?.headers ?? new Headers();
      return new Response(null, {
        status: init?.status ?? 302,
        headers: { ...Object.fromEntries(headers.entries()), Location: url },
      });
    }),
    json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), {
      status: init?.status ?? 200,
      headers: init?.headers ?? new Headers({ 'Content-Type': 'application/json' }),
    }),
  },
}));

vi.mock('@pagespace/lib/auth/session-service', () => ({
  sessionService: {
    createSession: vi.fn().mockResolvedValue('ps_sess_mock'),
    validateSession: vi.fn().mockResolvedValue({
      sessionId: 'mock-sid',
      userId: 'user-1',
      type: 'user',
      scopes: ['*'],
      userRole: 'user',
      tokenVersion: 0,
      adminRoleVersion: 0,
      expiresAt: new Date(Date.now() + 86400000),
    }),
    revokeAllUserSessions: vi.fn().mockResolvedValue(0),
    revokeWebUserSessions: vi.fn().mockResolvedValue(0),
    revokeAdminUserSessions: vi.fn().mockResolvedValue(0),
  },
}));
vi.mock('@pagespace/lib/auth/csrf-utils', () => ({
  generateCSRFToken: vi.fn().mockReturnValue('mock-csrf'),
}));
vi.mock('@pagespace/lib/auth/constants', () => ({
  SESSION_DURATION_MS: 604800000,
}));
vi.mock('@pagespace/lib/auth/exchange-codes', () => ({
  createExchangeCode: vi.fn().mockResolvedValue('exchange-code-abc'),
}));
vi.mock('@pagespace/lib/auth/device-auth-utils', () => ({
  validateOrCreateDeviceToken: vi.fn().mockResolvedValue({
    deviceToken: 'ps_dev_native',
    deviceTokenRecordId: 'dt-1',
    isNew: true,
  }),
}));

vi.mock('@pagespace/lib/auth/magic-link-service', () => ({
  verifyMagicLinkToken: vi.fn(),
}));

vi.mock('@pagespace/lib/auth/account-lockout', () => ({
  resetFailedLoginAttempts: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@pagespace/lib/auth/verification-utils', () => ({
  markEmailVerified: vi.fn(),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    auth: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    security: {
      warn: vi.fn(),
    },
  },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/monitoring/activity-tracker', () => ({
  trackAuthEvent: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  getClientIP: vi.fn().mockReturnValue('127.0.0.1'),
  revokeSessionsForLogin: vi.fn().mockResolvedValue(0),
}));

vi.mock('@/lib/auth/cookie-config', () => ({
  appendSessionCookie: vi.fn(),
}));

vi.mock('@pagespace/lib/onboarding/home-drive', () => ({
  // Shape matters: the route reads `.created`, so a bare null would make every
  // test here take the provisioning catch instead of the real path.
  provisionHomeDriveIfNeeded: vi.fn().mockResolvedValue({ driveId: 'home-drive', created: false }),
}));

vi.mock('@/lib/repositories/auth-repository', () => ({
  authRepository: {
    findUserById: vi.fn().mockResolvedValue({
      id: 'user-1',
      tokenVersion: 7,
    }),
  },
}));

vi.mock('@/lib/repositories/drive-invite-repository', () => ({
  driveInviteRepository: {
    findUserVerificationStatusById: vi
      .fn()
      .mockResolvedValue({ email: 'user@example.com', emailVerified: null, suspendedAt: null }),
  },
}));

vi.mock('@/lib/auth/native-invite-acceptance', () => ({
  consumeAnyInviteIfPresent: vi.fn().mockResolvedValue({ kind: null, invitedDriveId: null, invitedPageId: null, connectionId: null }),
  consumeAllInvitesForEmail: vi.fn().mockResolvedValue({ drivesAccepted: 0, pagesAccepted: 0, connectionsCreated: 0 }),
}));

import { GET, POST } from '../route';
import { verifyMagicLinkToken } from '@pagespace/lib/auth/magic-link-service';
import { createExchangeCode } from '@pagespace/lib/auth/exchange-codes';
import { validateOrCreateDeviceToken } from '@pagespace/lib/auth/device-auth-utils';
import { sessionService } from '@pagespace/lib/auth/session-service';
import { appendSessionCookie } from '@/lib/auth/cookie-config';
import { revokeSessionsForLogin } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';

const iosMetadata = JSON.stringify({
  platform: 'ios',
  deviceId: 'dev-ios-1',
  deviceName: 'iOS App',
});

const redeem = (body: Record<string, unknown>) =>
  POST(
    new Request('http://localhost/api/auth/magic-link/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

const json = async (response: Response) => (await response.json()) as Record<string, unknown>;

describe('POST /api/auth/magic-link/verify — native-bound link', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(verifyMagicLinkToken).mockResolvedValue({
      ok: true,
      data: { userId: 'user-1', isNewUser: false, metadata: iosMetadata },
    });
  });

  it('given the bound device, returns bearer tokens, the cookie, and the landing path', async () => {
    const response = await redeem({ token: 'ps_magic_valid', deviceId: 'dev-ios-1' });

    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body).toEqual(
      expect.objectContaining({
        sessionToken: 'ps_sess_mock',
        csrfToken: 'mock-csrf',
        deviceToken: 'ps_dev_native',
        redirectTo: '/dashboard?auth=success',
        isNewUser: false,
        user: expect.objectContaining({ id: 'user-1' }),
      }),
    );
    expect(appendSessionCookie).toHaveBeenCalledWith(expect.any(Headers), 'ps_sess_mock');
    expect(response.headers.get('Set-Cookie')).toContain('csrf_token=mock-csrf');
  });

  it('mints the device token for the platform the link was bound to — never a default', async () => {
    await redeem({ token: 'ps_magic_valid', deviceId: 'dev-ios-1' });

    expect(validateOrCreateDeviceToken).toHaveBeenCalledWith(
      expect.objectContaining({ platform: 'ios', deviceId: 'dev-ios-1', userId: 'user-1', tokenVersion: 7 }),
    );
    expect(createExchangeCode).not.toHaveBeenCalled();
  });

  it('scopes the session and the fixation revoke to the bound device', async () => {
    await redeem({ token: 'ps_magic_valid', deviceId: 'dev-ios-1' });

    expect(revokeSessionsForLogin).toHaveBeenCalledWith('user-1', 'dev-ios-1', 'magic_link_login', 'magic-link');
    expect(sessionService.createSession).toHaveBeenCalledWith(expect.objectContaining({ deviceId: 'dev-ios-1' }));
  });

  it('records the platform on the audit trail', async () => {
    await redeem({ token: 'ps_magic_valid', deviceId: 'dev-ios-1' });

    expect(auditRequest).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        eventType: 'auth.login.success',
        details: { method: 'magic_link', platform: 'ios' },
      }),
    );
  });

  it('given an Android-bound link, mints an android device token and reports that platform', async () => {
    vi.mocked(verifyMagicLinkToken).mockResolvedValue({
      ok: true,
      data: {
        userId: 'user-1',
        isNewUser: false,
        metadata: JSON.stringify({ platform: 'android', deviceId: 'dev-pixel', deviceName: 'Android App' }),
      },
    });

    const body = await json(await redeem({ token: 'ps_magic_valid', deviceId: 'dev-pixel' }));

    expect(body).toEqual(expect.objectContaining({ deviceToken: 'ps_dev_native' }));
    expect(validateOrCreateDeviceToken).toHaveBeenCalledWith(
      expect.objectContaining({ platform: 'android', deviceId: 'dev-pixel' }),
    );
  });

  it('given a different device, withholds bearer tokens but still signs the cookie session in', async () => {
    const response = await redeem({ token: 'ps_magic_valid', deviceId: 'dev-someone-else' });

    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body).not.toHaveProperty('sessionToken');
    expect(body).not.toHaveProperty('csrfToken');
    expect(body).not.toHaveProperty('deviceToken');
    expect(body.redirectTo).toBe('/dashboard?auth=success');
    expect(appendSessionCookie).toHaveBeenCalledWith(expect.any(Headers), 'ps_sess_mock');
    expect(loggers.auth.info).toHaveBeenCalledWith(
      'Magic link redeemed with no device handoff',
      expect.objectContaining({ platform: 'ios' }),
    );
  });

  it('given a different device, does NOT rotate the bound phone\'s device token', async () => {
    // Minting overwrites the stored hash, so minting for an absent device
    // would destroy the credential that phone is still holding — on iOS the
    // only one it has.
    await redeem({ token: 'ps_magic_valid', deviceId: 'dev-someone-else' });

    expect(validateOrCreateDeviceToken).not.toHaveBeenCalled();
  });

  it('given a different device, does NOT revoke the bound phone\'s sessions by device', async () => {
    await redeem({ token: 'ps_magic_valid', deviceId: 'dev-someone-else' });

    expect(revokeSessionsForLogin).toHaveBeenCalledWith('user-1', undefined, 'magic_link_login', 'magic-link');
    expect(sessionService.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: undefined }),
    );
  });

  it('given no device at all (a plain browser), withholds tokens and mints nothing', async () => {
    const response = await redeem({ token: 'ps_magic_valid' });

    const body = await json(response);
    expect(body).not.toHaveProperty('sessionToken');
    expect(body).not.toHaveProperty('deviceToken');
    expect(validateOrCreateDeviceToken).not.toHaveBeenCalled();
    expect(auditRequest).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ details: { method: 'magic_link' } }),
    );
  });

  it('given a new user on the bound device, flags welcome on the landing path', async () => {
    vi.mocked(verifyMagicLinkToken).mockResolvedValue({
      ok: true,
      data: { userId: 'user-1', isNewUser: true, metadata: iosMetadata },
    });

    const body = await json(await redeem({ token: 'ps_magic_valid', deviceId: 'dev-ios-1' }));

    expect(body.redirectTo).toBe('/dashboard?auth=success&welcome=true');
    expect(body.isNewUser).toBe(true);
  });

  it('honours a safe next and drops an unsafe one', async () => {
    const safe = await json(await redeem({ token: 'ps_magic_valid', deviceId: 'dev-ios-1', next: '/dashboard/d1' }));
    expect(safe.redirectTo).toBe('/dashboard/d1?auth=success');

    vi.clearAllMocks();
    vi.mocked(verifyMagicLinkToken).mockResolvedValue({
      ok: true,
      data: { userId: 'user-1', isNewUser: false, metadata: iosMetadata },
    });
    const unsafe = await json(await redeem({ token: 'ps_magic_valid', deviceId: 'dev-ios-1', next: '//evil.example/x' }));
    expect(unsafe.redirectTo).toBe('/dashboard?auth=success');
  });

  it('given the device-token mint fails, degrades to the cookie session instead of failing the login', async () => {
    vi.mocked(validateOrCreateDeviceToken).mockRejectedValueOnce(new Error('keystore down'));

    const response = await redeem({ token: 'ps_magic_valid', deviceId: 'dev-ios-1' });

    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body).not.toHaveProperty('sessionToken');
    // No user either: the caller must not read this as "signed in on this device".
    expect(body.user).toBeNull();
    expect(appendSessionCookie).toHaveBeenCalledWith(expect.any(Headers), 'ps_sess_mock');
    expect(loggers.auth.warn).toHaveBeenCalledWith(
      'Failed to create device handoff for magic link',
      expect.objectContaining({ platform: 'ios' }),
    );
  });
});

describe('POST /api/auth/magic-link/verify — links with no device binding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('given a plain web link, signs the cookie session in and mints no device token', async () => {
    vi.mocked(verifyMagicLinkToken).mockResolvedValue({
      ok: true,
      data: { userId: 'user-1', isNewUser: false },
    });

    const response = await redeem({ token: 'ps_magic_valid', deviceId: 'dev-ios-1' });

    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body).not.toHaveProperty('sessionToken');
    expect(body.user).toBeNull();
    expect(validateOrCreateDeviceToken).not.toHaveBeenCalled();
    expect(appendSessionCookie).toHaveBeenCalledWith(expect.any(Headers), 'ps_sess_mock');
  });

  it('given a platform this build does not know, treats it as unbound', async () => {
    vi.mocked(verifyMagicLinkToken).mockResolvedValue({
      ok: true,
      data: {
        userId: 'user-1',
        isNewUser: false,
        metadata: JSON.stringify({ platform: 'watchos', deviceId: 'dev-ios-1' }),
      },
    });

    const body = await json(await redeem({ token: 'ps_magic_valid', deviceId: 'dev-ios-1' }));

    expect(body).not.toHaveProperty('sessionToken');
    expect(validateOrCreateDeviceToken).not.toHaveBeenCalled();
    expect(revokeSessionsForLogin).toHaveBeenCalledWith('user-1', undefined, 'magic_link_login', 'magic-link');
  });

  it('given a desktop-bound link, mints nothing — the desktop handoff belongs to the emailed GET', async () => {
    vi.mocked(verifyMagicLinkToken).mockResolvedValue({
      ok: true,
      data: {
        userId: 'user-1',
        isNewUser: false,
        metadata: JSON.stringify({ platform: 'desktop', deviceId: 'dev-mac' }),
      },
    });

    await redeem({ token: 'ps_magic_valid', deviceId: 'dev-mac' });

    // A one-time code carrying session + CSRF + device tokens must never be
    // created for a door that cannot hand it to anyone.
    expect(createExchangeCode).not.toHaveBeenCalled();
    expect(validateOrCreateDeviceToken).not.toHaveBeenCalled();
  });

  it('given a desktop-bound link, answers the cookie session only — the exchange code stays on GET', async () => {
    vi.mocked(verifyMagicLinkToken).mockResolvedValue({
      ok: true,
      data: {
        userId: 'user-1',
        isNewUser: false,
        metadata: JSON.stringify({ platform: 'desktop', deviceId: 'dev-mac' }),
      },
    });

    const body = await json(await redeem({ token: 'ps_magic_valid', deviceId: 'dev-mac' }));

    expect(body).not.toHaveProperty('sessionToken');
    expect(body).not.toHaveProperty('deviceToken');
    expect(body.redirectTo).toBe('/dashboard?auth=success');
  });
});

describe('POST /api/auth/magic-link/verify — failures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['TOKEN_EXPIRED', 'magic_link_expired', 401],
    ['TOKEN_ALREADY_USED', 'magic_link_used', 401],
    ['TOKEN_NOT_FOUND', 'invalid_token', 401],
    ['USER_SUSPENDED', 'account_suspended', 403],
  ] as const)('maps %s to { error: %s } with status %i', async (code, error, status) => {
    vi.mocked(verifyMagicLinkToken).mockResolvedValue({
      ok: false,
      error: { code, message: 'nope' },
    } as Awaited<ReturnType<typeof verifyMagicLinkToken>>);

    const response = await redeem({ token: 'ps_magic_bad', deviceId: 'dev-ios-1' });

    expect(response.status).toBe(status);
    expect(await json(response)).toEqual({ error });
    expect(sessionService.createSession).not.toHaveBeenCalled();
    expect(appendSessionCookie).not.toHaveBeenCalled();
  });

  it('rejects a body with no token', async () => {
    const response = await redeem({ deviceId: 'dev-ios-1' });

    expect(response.status).toBe(400);
    expect(verifyMagicLinkToken).not.toHaveBeenCalled();
  });

  it('rejects a body that is not JSON', async () => {
    const response = await POST(
      new Request('http://localhost/api/auth/magic-link/verify', { method: 'POST', body: 'not json' }),
    );

    expect(response.status).toBe(400);
  });

  it('answers 500 with no cookie when the core throws', async () => {
    vi.mocked(verifyMagicLinkToken).mockRejectedValue(new Error('db down'));

    const response = await redeem({ token: 'ps_magic_valid' });

    expect(response.status).toBe(500);
    expect(await json(response)).toEqual({ error: 'server_error' });
    expect(appendSessionCookie).not.toHaveBeenCalled();
  });
});

describe('GET /api/auth/magic-link/verify — native-bound link opened in a browser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(verifyMagicLinkToken).mockResolvedValue({
      ok: true,
      data: { userId: 'user-1', isNewUser: false, metadata: iosMetadata },
    });
  });

  it('mints no device token — the phone is not here, and minting would rotate its credential', async () => {
    await GET(
      new Request('http://localhost/api/auth/magic-link/verify?token=ps_magic_valid', { method: 'GET' }),
    );

    expect(validateOrCreateDeviceToken).not.toHaveBeenCalled();
    expect(revokeSessionsForLogin).toHaveBeenCalledWith('user-1', undefined, 'magic_link_login', 'magic-link');
  });

  it('signs the browser in with a cookie and never puts a token in the redirect', async () => {
    const response = await GET(
      new Request('http://localhost/api/auth/magic-link/verify?token=ps_magic_valid', { method: 'GET' }),
    );

    expect(response.status).toBe(302);
    const location = response.headers.get('Location') || '';
    expect(location).toContain('/dashboard');
    expect(location).toContain('auth=success');
    expect(location).not.toContain('desktopExchange');
    expect(location).not.toContain('ps_dev_native');
    expect(location).not.toContain('ps_sess_mock');
    expect(createExchangeCode).not.toHaveBeenCalled();
    expect(appendSessionCookie).toHaveBeenCalledWith(expect.any(Headers), 'ps_sess_mock');
  });
});
