/**
 * Logout Route Tests
 *
 * Tests are organized by behavior, not implementation.
 * We only mock at system boundaries: database, device token service, auth.
 *
 * Key behaviors tested:
 * - Authentication required with CSRF
 * - Successful logout (clears cookies, returns success)
 * - Graceful handling of failures (continues logout even if parts fail)
 * - Device token revocation (web header vs desktop body)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextResponse } from 'next/server';

// === MOCKS AT SYSTEM BOUNDARIES ONLY ===

// Mock auth module - internal boundary
const { mockAuthenticateRequestWithOptions, mockIsAuthError } = vi.hoisted(() => ({
  mockAuthenticateRequestWithOptions: vi.fn(),
  mockIsAuthError: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: mockAuthenticateRequestWithOptions,
  isAuthError: mockIsAuthError,
}));

// Mock device auth utilities - external service boundary
const { mockRevokeDeviceTokenByValue, mockRevokeDeviceTokensByDevice } = vi.hoisted(() => ({
  mockRevokeDeviceTokenByValue: vi.fn(),
  mockRevokeDeviceTokensByDevice: vi.fn(),
}));

vi.mock('@pagespace/lib/device-auth-utils', () => ({
  revokeDeviceTokenByValue: mockRevokeDeviceTokenByValue,
  revokeDeviceTokensByDevice: mockRevokeDeviceTokensByDevice,
}));

// Mock database - external storage boundary
const { mockDbDeleteWhere } = vi.hoisted(() => ({
  mockDbDeleteWhere: vi.fn(),
}));

vi.mock('@pagespace/db', () => ({
  db: {
    delete: vi.fn(() => ({
      where: mockDbDeleteWhere,
    })),
  },
  refreshTokens: {},
  eq: vi.fn((field: unknown, value: unknown) => ({ field, value, type: 'eq' })),
}));

// Mock server utilities (provide implementations, don't verify calls)
vi.mock('@pagespace/lib/server', () => ({
  logAuthEvent: vi.fn(),
  loggers: {
    auth: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

// Mock activity tracker (internal analytics - don't verify calls)
vi.mock('@pagespace/lib/activity-tracker', () => ({
  trackAuthEvent: vi.fn(),
}));

// Mock cookie
vi.mock('cookie', () => ({
  parse: vi.fn((cookieStr: string) => {
    const cookies: Record<string, string> = {};
    if (cookieStr) {
      cookieStr.split(';').forEach(pair => {
        const [key, value] = pair.trim().split('=');
        if (key && value) cookies[key] = value;
      });
    }
    return cookies;
  }),
  serialize: vi.fn((name: string, value: string) => `${name}=${value}`),
}));

// Import after mocks
import { POST } from '../route';

// === TEST HELPERS ===

const mockWebAuth = (userId: string) => ({
  userId,
  tokenVersion: 0,
  tokenType: 'jwt' as const,
  source: 'cookie' as const,
  role: 'user' as const,
});

const mockAuthError = (status = 401) => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

const createRequest = (options: {
  cookies?: Record<string, string>;
  headers?: Record<string, string>;
  body?: object;
} = {}) => {
  const cookieHeader = options.cookies
    ? Object.entries(options.cookies).map(([k, v]) => `${k}=${v}`).join('; ')
    : '';

  return new Request('https://example.com/api/auth/logout', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookieHeader && { cookie: cookieHeader }),
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
};

// === TESTS ===

describe('POST /api/auth/logout', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: authenticated user
    mockAuthenticateRequestWithOptions.mockResolvedValue(mockWebAuth('user_123'));
    mockIsAuthError.mockReturnValue(false);

    // Default: all operations succeed
    mockDbDeleteWhere.mockResolvedValue(undefined);
    mockRevokeDeviceTokenByValue.mockResolvedValue(true);
    mockRevokeDeviceTokensByDevice.mockResolvedValue(1);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // --- Authentication ---

  describe('authentication', () => {
    it('returns_401_when_not_authenticated', async () => {
      mockIsAuthError.mockReturnValue(true);
      mockAuthenticateRequestWithOptions.mockResolvedValue(mockAuthError(401));

      const response = await POST(createRequest());

      expect(response.status).toBe(401);
    });

    // TODO: REVIEW - Should logout require CSRF protection?
    // Current behavior: yes, requires CSRF. This prevents cross-site logout attacks.
    it('requires_csrf_token_for_logout', async () => {
      await POST(createRequest());

      expect(mockAuthenticateRequestWithOptions).toHaveBeenCalledWith(
        expect.any(Request),
        { allow: ['jwt'], requireCSRF: true }
      );
    });
  });

  // --- Successful Logout ---

  describe('successful_logout', () => {
    it('returns_200_with_success_message', async () => {
      const response = await POST(createRequest());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.message).toBe('Logged out successfully');
    });

    it('clears_auth_cookies', async () => {
      const response = await POST(createRequest({
        cookies: {
          accessToken: 'old-access-token',
          refreshToken: 'old-refresh-token',
        },
      }));

      const cookies = response.headers.getSetCookie();
      expect(cookies.some(c => c.includes('accessToken'))).toBe(true);
      expect(cookies.some(c => c.includes('refreshToken'))).toBe(true);
    });

    it('deletes_refresh_token_from_database', async () => {
      await POST(createRequest({
        cookies: { refreshToken: 'valid-refresh-token' },
      }));

      expect(mockDbDeleteWhere).toHaveBeenCalled();
    });
  });

  // --- Graceful Failure Handling ---

  describe('graceful_failure_handling', () => {
    it('succeeds_when_no_refresh_token_in_cookies', async () => {
      const response = await POST(createRequest());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.message).toBe('Logged out successfully');
    });

    it('succeeds_when_refresh_token_delete_fails', async () => {
      mockDbDeleteWhere.mockRejectedValue(new Error('Token not found'));

      const response = await POST(createRequest({
        cookies: { refreshToken: 'invalid-token' },
      }));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.message).toBe('Logged out successfully');
    });

    it('succeeds_when_device_token_revocation_fails', async () => {
      mockRevokeDeviceTokenByValue.mockRejectedValue(new Error('Revocation failed'));

      const response = await POST(createRequest({
        headers: { 'X-Device-Token': 'device-token-123' },
      }));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.message).toBe('Logged out successfully');
    });

    it('succeeds_when_desktop_device_token_revocation_fails', async () => {
      mockRevokeDeviceTokensByDevice.mockRejectedValue(new Error('Revocation failed'));

      const response = await POST(createRequest({
        body: { deviceId: 'desktop-device-123', platform: 'desktop' },
      }));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.message).toBe('Logged out successfully');
    });
  });

  // --- Device Token Handling ---

  describe('device_token_revocation', () => {
    it('revokes_device_token_from_header_for_web', async () => {
      await POST(createRequest({
        headers: { 'X-Device-Token': 'device-token-123' },
      }));

      expect(mockRevokeDeviceTokenByValue).toHaveBeenCalledWith(
        'device-token-123',
        'logout'
      );
    });

    it('revokes_device_token_by_device_id_for_desktop', async () => {
      await POST(createRequest({
        body: { deviceId: 'desktop-device-123', platform: 'desktop' },
      }));

      expect(mockRevokeDeviceTokensByDevice).toHaveBeenCalledWith(
        'user_123',
        'desktop-device-123',
        'desktop',
        'logout'
      );
    });

    // TODO: REVIEW - Is header priority over body correct for device token source?
    // Current behavior: header device token takes priority over body deviceId
    it('prefers_header_device_token_over_body', async () => {
      await POST(createRequest({
        headers: { 'X-Device-Token': 'header-token' },
        body: { deviceId: 'body-device', platform: 'web' },
      }));

      expect(mockRevokeDeviceTokenByValue).toHaveBeenCalledWith('header-token', 'logout');
      expect(mockRevokeDeviceTokensByDevice).not.toHaveBeenCalled();
    });

    it('handles_logout_without_device_token', async () => {
      const response = await POST(createRequest());

      expect(response.status).toBe(200);
      expect(mockRevokeDeviceTokenByValue).not.toHaveBeenCalled();
      expect(mockRevokeDeviceTokensByDevice).not.toHaveBeenCalled();
    });
  });
});
