/**
 * Tests for desktop platform handling in GET /api/auth/magic-link/verify
 *
 * Desktop magic links always create a web session (cookies) as a fallback,
 * then additionally generate an exchange code for desktop token handoff.
 * This means the link works in any browser, not just on the desktop device.
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

vi.mock('@pagespace/lib/auth', () => ({
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
  },
  generateCSRFToken: vi.fn().mockReturnValue('mock-csrf'),
  SESSION_DURATION_MS: 604800000,
  createExchangeCode: vi.fn().mockResolvedValue('exchange-code-abc'),
  validateOrCreateDeviceToken: vi.fn().mockResolvedValue({
    deviceToken: 'ps_dev_desktop',
    deviceTokenRecordId: 'dt-1',
    isNew: true,
  }),
}));

vi.mock('@pagespace/lib/auth/magic-link-service', () => ({
  verifyMagicLinkToken: vi.fn(),
}));

vi.mock('@pagespace/lib/auth/verification-utils', () => ({
  markEmailVerified: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    auth: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    security: {
      warn: vi.fn(),
    },
  },
  auditRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/monitoring/activity-tracker', () => ({
  trackAuthEvent: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  getClientIP: vi.fn().mockReturnValue('127.0.0.1'),
}));

vi.mock('@/lib/auth/cookie-config', () => ({
  appendSessionCookie: vi.fn(),
}));

vi.mock('@/lib/onboarding/getting-started-drive', () => ({
  provisionGettingStartedDriveIfNeeded: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/repositories/auth-repository', () => ({
  authRepository: {
    findUserById: vi.fn().mockResolvedValue({
      id: 'user-1',
      tokenVersion: 7,
    }),
  },
}));

import { GET } from '../route';
import { verifyMagicLinkToken } from '@pagespace/lib/auth/magic-link-service';
import { createExchangeCode } from '@pagespace/lib/auth/exchange-codes';
import { appendSessionCookie } from '@/lib/auth/cookie-config';
import { provisionGettingStartedDriveIfNeeded } from '@/lib/onboarding/getting-started-drive';

const desktopMetadata = JSON.stringify({
  platform: 'desktop',
  deviceId: 'dev-123',
  deviceName: 'My Mac',
});

const createVerifyRequest = (token = 'ps_magic_validtoken') =>
  new Request(`http://localhost/api/auth/magic-link/verify?token=${token}`, {
    method: 'GET',
  });

describe('GET /api/auth/magic-link/verify - desktop platform', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(verifyMagicLinkToken).mockResolvedValue({
      ok: true,
      data: { userId: 'user-1', isNewUser: false, metadata: desktopMetadata },
    });
  });

  it('redirects to dashboard (not deep link) with desktopExchange param', async () => {
    const response = await GET(createVerifyRequest());

    expect(response.status).toBe(302);
    const location = response.headers.get('Location') || '';
    expect(location).toContain('/dashboard');
    expect(location).toContain('desktopExchange=exchange-code-abc');
    expect(location).not.toContain('pagespace://');
  });

  it('sets session cookies for browser fallback', async () => {
    await GET(createVerifyRequest());

    expect(appendSessionCookie).toHaveBeenCalled();
  });

  it('creates exchange code with correct session token', async () => {
    await GET(createVerifyRequest());

    expect(createExchangeCode).toHaveBeenCalledWith(expect.objectContaining({
      sessionToken: 'ps_sess_mock',
      provider: 'magic-link',
      userId: 'user-1',
    }));
  });

  it('provisions Getting Started drive for new desktop users', async () => {
    vi.mocked(verifyMagicLinkToken).mockResolvedValue({
      ok: true,
      data: { userId: 'user-1', isNewUser: true, metadata: desktopMetadata },
    });

    await GET(createVerifyRequest());

    expect(provisionGettingStartedDriveIfNeeded).toHaveBeenCalledWith('user-1');
  });

  it('does not provision drive for existing desktop users', async () => {
    await GET(createVerifyRequest());

    expect(provisionGettingStartedDriveIfNeeded).not.toHaveBeenCalled();
  });

  it('falls through to web flow when no desktop metadata', async () => {
    vi.mocked(verifyMagicLinkToken).mockResolvedValue({
      ok: true,
      data: { userId: 'user-1', isNewUser: false, metadata: null },
    });

    const response = await GET(createVerifyRequest());

    const location = response.headers.get('Location') || '';
    expect(location).not.toContain('desktopExchange');
    expect(createExchangeCode).not.toHaveBeenCalled();
  });

  it('includes welcome param for new users', async () => {
    vi.mocked(verifyMagicLinkToken).mockResolvedValue({
      ok: true,
      data: { userId: 'user-1', isNewUser: true, metadata: desktopMetadata },
    });

    const response = await GET(createVerifyRequest());

    const location = response.headers.get('Location') || '';
    expect(location).toContain('welcome=true');
  });
});
