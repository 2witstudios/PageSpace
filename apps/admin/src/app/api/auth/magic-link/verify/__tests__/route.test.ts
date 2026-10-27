import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from '../route';

/**
 * Security tests for the magic-link verify route's `next` parameter sanitization.
 *
 * Vulnerability: Open redirect via backslash variants and encoded bypass inputs.
 * Attack Vector: Backslash `/\evil.example`, protocol-relative `//evil.example`,
 *   or percent-encoded variants `/%5Cevil.example` that `new URL` normalizes to
 *   external hostnames after the simple `startsWith` guard passes.
 * Fix: `sanitizeNext` — decode, parse with URL, verify hostname is `internal.invalid`.
 */

// Hoist all mocks so they are available inside vi.mock factories
const {
  mockRedirect,
  mockVerifyMagicLinkToken,
  mockDbFindFirst,
  mockRevokeAdminUserSessions,
  mockCreateSession,
} = vi.hoisted(() => {
  const mockDbFindFirst = vi.fn().mockResolvedValue({ role: 'admin' });
  const mockVerifyMagicLinkToken = vi.fn().mockResolvedValue({
    ok: true,
    data: { userId: 'user-123' },
  });
  const mockRevokeAdminUserSessions = vi.fn().mockResolvedValue(undefined);
  const mockCreateSession = vi.fn().mockResolvedValue('mock-session-token');
  const mockRedirect = vi.fn(
    (url: URL | string, init?: ResponseInit) =>
      new Response(null, {
        status: (init as { status?: number })?.status ?? 302,
        headers: { Location: url.toString() },
      })
  );
  return {
    mockRedirect,
    mockVerifyMagicLinkToken,
    mockDbFindFirst,
    mockRevokeAdminUserSessions,
    mockCreateSession,
  };
});

vi.mock('next/server', () => ({
  NextResponse: {
    redirect: mockRedirect,
  },
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      users: {
        findFirst: mockDbFindFirst,
      },
    },
  },
}));

vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
}));

vi.mock('@pagespace/db/schema/auth', () => ({
  users: { id: 'id', role: 'role' },
}));

vi.mock('@pagespace/lib/auth/session-service', () => ({
  sessionService: {
    revokeAdminUserSessions: mockRevokeAdminUserSessions,
    createSession: mockCreateSession,
  },
}));

vi.mock('@pagespace/lib/auth/magic-link-service', () => ({
  verifyMagicLinkToken: mockVerifyMagicLinkToken,
}));

vi.mock('@pagespace/lib/auth/constants', () => ({
  SESSION_DURATION_MS: 7 * 24 * 60 * 60 * 1000,
  ADMIN_SESSION_SERVICE: 'admin-console',
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    auth: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
    api: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: vi.fn(),
}));

vi.mock('@/lib/auth/cookie-config', () => ({
  appendSessionCookie: vi.fn(),
}));

// Use a fixed admin URL for all assertions
process.env.ADMIN_URL = 'http://localhost:3005';

function makeRequest(next?: string): Request {
  const base = 'http://localhost:3005/api/auth/magic-link/verify?token=valid-token';
  const url = next !== undefined ? `${base}&next=${next}` : base;
  return new Request(url);
}

describe('GET /api/auth/magic-link/verify — next parameter sanitization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore happy-path defaults after clearAllMocks resets call counts
    mockVerifyMagicLinkToken.mockResolvedValue({ ok: true, data: { userId: 'user-123' } });
    mockDbFindFirst.mockResolvedValue({ role: 'admin' });
    mockRevokeAdminUserSessions.mockResolvedValue(undefined);
    mockCreateSession.mockResolvedValue('mock-session-token');
    mockRedirect.mockImplementation(
      (url: URL | string, init?: ResponseInit) =>
        new Response(null, {
          status: (init as { status?: number })?.status ?? 302,
          headers: { Location: url.toString() },
        })
    );
  });

  describe('safe next values — should redirect to the specified path', () => {
    it('GET_withSimplePath_redirectsToPath', async () => {
      await GET(makeRequest('/dashboard'));

      expect(mockRedirect).toHaveBeenCalledOnce();
      const redirectUrl = mockRedirect.mock.calls[0][0] as URL;
      expect(redirectUrl.pathname).toBe('/dashboard');
      expect(redirectUrl.hostname).toBe('localhost');
    });

    it('GET_withPathAndQuery_preservesQueryString', async () => {
      await GET(makeRequest('/users?page=2'));

      expect(mockRedirect).toHaveBeenCalledOnce();
      const redirectUrl = mockRedirect.mock.calls[0][0] as URL;
      expect(redirectUrl.pathname).toBe('/users');
      expect(redirectUrl.search).toBe('?page=2');
    });

    it('GET_withEmptyNext_redirectsToRoot', async () => {
      await GET(makeRequest());

      expect(mockRedirect).toHaveBeenCalledOnce();
      const redirectUrl = mockRedirect.mock.calls[0][0] as URL;
      expect(redirectUrl.pathname).toBe('/');
    });
  });

  describe('open-redirect bypass attempts — must all fall back to /', () => {
    it('GET_withProtocolRelativeUrl_redirectsToRoot', async () => {
      // //evil.example — classic protocol-relative open redirect
      await GET(makeRequest('//evil.example'));

      expect(mockRedirect).toHaveBeenCalledOnce();
      const redirectUrl = mockRedirect.mock.calls[0][0] as URL;
      expect(redirectUrl.hostname).toBe('localhost');
      expect(redirectUrl.pathname).toBe('/');
    });

    it('GET_withBackslashAfterSlash_redirectsToRoot', async () => {
      // /\evil.example — backslash bypass; new URL treats \ as /
      await GET(makeRequest('/\\evil.example'));

      expect(mockRedirect).toHaveBeenCalledOnce();
      const redirectUrl = mockRedirect.mock.calls[0][0] as URL;
      expect(redirectUrl.hostname).toBe('localhost');
      expect(redirectUrl.pathname).toBe('/');
    });

    it('GET_withEncodedBackslash_redirectsToRoot', async () => {
      // /%5Cevil.example — percent-encoded backslash
      await GET(makeRequest('/%5Cevil.example'));

      expect(mockRedirect).toHaveBeenCalledOnce();
      const redirectUrl = mockRedirect.mock.calls[0][0] as URL;
      expect(redirectUrl.hostname).toBe('localhost');
      expect(redirectUrl.pathname).toBe('/');
    });

    it('GET_withAbsoluteHttpUrl_redirectsToRoot', async () => {
      // http://evil.example/steal — absolute external URL
      await GET(makeRequest('http://evil.example/steal'));

      expect(mockRedirect).toHaveBeenCalledOnce();
      const redirectUrl = mockRedirect.mock.calls[0][0] as URL;
      expect(redirectUrl.hostname).toBe('localhost');
      expect(redirectUrl.pathname).toBe('/');
    });

    it('GET_withDoubleEncodedSlashes_redirectsToRoot', async () => {
      // %2F%2Fevil.example — double-encoded protocol-relative
      await GET(makeRequest('%2F%2Fevil.example'));

      expect(mockRedirect).toHaveBeenCalledOnce();
      const redirectUrl = mockRedirect.mock.calls[0][0] as URL;
      expect(redirectUrl.hostname).toBe('localhost');
      expect(redirectUrl.pathname).toBe('/');
    });
  });
});
