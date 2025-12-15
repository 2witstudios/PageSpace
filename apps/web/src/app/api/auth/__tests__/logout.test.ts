import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { POST } from '../logout/route';

// Mock dependencies
vi.mock('@pagespace/db', () => ({
  refreshTokens: { token: 'token' },
  db: {
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  },
  eq: vi.fn((field, value) => ({ field, value })),
}));

vi.mock('cookie', () => ({
  parse: vi.fn().mockReturnValue({ refreshToken: 'mock-refresh-token' }),
  serialize: vi.fn().mockReturnValue('mock-cookie'),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    auth: {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  },
  logAuthEvent: vi.fn(),
}));

vi.mock('@pagespace/lib/activity-tracker', () => ({
  trackAuthEvent: vi.fn(),
}));

vi.mock('@pagespace/lib/device-auth-utils', () => ({
  revokeDeviceTokenByValue: vi.fn().mockResolvedValue(true),
  revokeDeviceTokensByDevice: vi.fn().mockResolvedValue(1),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn().mockResolvedValue({
    userId: 'test-user-id',
    role: 'user',
    tokenVersion: 0,
    tokenType: 'jwt',
    source: 'cookie',
  }),
  isAuthError: vi.fn().mockReturnValue(false),
}));

import { db, eq } from '@pagespace/db';
import { parse, serialize } from 'cookie';
import { logAuthEvent } from '@pagespace/lib/server';
import { trackAuthEvent } from '@pagespace/lib/activity-tracker';
import {
  revokeDeviceTokenByValue,
  revokeDeviceTokensByDevice,
} from '@pagespace/lib/device-auth-utils';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

describe('/api/auth/logout', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: authenticated user
    (authenticateRequestWithOptions as unknown as Mock).mockResolvedValue({
      userId: 'test-user-id',
      role: 'user',
      tokenVersion: 0,
      tokenType: 'jwt',
      source: 'cookie',
    });
    (isAuthError as unknown as Mock).mockReturnValue(false);
    (parse as unknown as Mock).mockReturnValue({ refreshToken: 'mock-refresh-token' });
  });

  describe('successful logout', () => {
    it('returns 200 on successful logout', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/logout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'accessToken=mock-access-token; refreshToken=mock-refresh-token',
          'X-CSRF-Token': 'mock-csrf-token',
        },
      });

      // Act
      const response = await POST(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(200);
      expect(body.message).toBe('Logged out successfully');
    });

    it('clears access and refresh token cookies', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/logout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'accessToken=mock-access-token; refreshToken=mock-refresh-token',
          'X-CSRF-Token': 'mock-csrf-token',
        },
      });

      // Act
      const response = await POST(request);

      // Assert - verify cookie contract: both tokens cleared with expires: epoch
      expect(response.headers.get('set-cookie')).toBeTruthy();

      // Verify accessToken cookie is cleared (expires in the past)
      // Must mirror original cookie attributes (sameSite, httpOnly, path) to guarantee overwrite
      expect(serialize).toHaveBeenCalledWith(
        'accessToken',
        '',
        expect.objectContaining({
          expires: new Date(0), // Epoch = cookie cleared
          httpOnly: true,
          sameSite: 'strict',
          path: '/',
        })
      );

      // Verify refreshToken cookie is cleared
      expect(serialize).toHaveBeenCalledWith(
        'refreshToken',
        '',
        expect.objectContaining({
          expires: new Date(0), // Epoch = cookie cleared
          httpOnly: true,
          sameSite: 'strict',
          path: '/',
        })
      );
    });

    it('deletes refresh token from database', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/logout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'accessToken=mock-access-token; refreshToken=mock-refresh-token',
          'X-CSRF-Token': 'mock-csrf-token',
        },
      });

      // Act
      await POST(request);

      // Assert - verify delete was called and eq was used with the parsed token
      expect(db.delete).toHaveBeenCalled();
      // Verify eq was called with the refresh token value from cookies
      expect(eq).toHaveBeenCalled();
      const eqCalls = (eq as Mock).mock.calls;
      const tokenDeleteCall = eqCalls.find(
        (call) => call[1] === 'mock-refresh-token'
      );
      expect(tokenDeleteCall).toBeDefined();
    });

    it('logs logout event', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/logout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'accessToken=mock-access-token; refreshToken=mock-refresh-token',
          'X-CSRF-Token': 'mock-csrf-token',
          'x-forwarded-for': '192.168.1.1',
        },
      });

      // Act
      await POST(request);

      // Assert
      expect(logAuthEvent).toHaveBeenCalledWith(
        'logout',
        'test-user-id',
        undefined,
        '192.168.1.1'
      );
      expect(trackAuthEvent).toHaveBeenCalledWith(
        'test-user-id',
        'logout',
        expect.objectContaining({
          ip: '192.168.1.1',
        })
      );
    });
  });

  describe('device token revocation', () => {
    it('revokes device token from X-Device-Token header', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/logout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'accessToken=mock-access-token; refreshToken=mock-refresh-token',
          'X-CSRF-Token': 'mock-csrf-token',
          'X-Device-Token': 'mock-device-token',
        },
      });

      // Act
      await POST(request);

      // Assert
      expect(revokeDeviceTokenByValue).toHaveBeenCalledWith(
        'mock-device-token',
        'logout'
      );
    });

    it('revokes device tokens by deviceId and platform from body', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/logout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'accessToken=mock-access-token; refreshToken=mock-refresh-token',
          'X-CSRF-Token': 'mock-csrf-token',
        },
        body: JSON.stringify({
          deviceId: 'device-123',
          platform: 'desktop',
        }),
      });

      // Act
      await POST(request);

      // Assert
      expect(revokeDeviceTokensByDevice).toHaveBeenCalledWith(
        'test-user-id',
        'device-123',
        'desktop',
        'logout'
      );
    });

    it('handles device token revocation failure gracefully', async () => {
      // Arrange
      (revokeDeviceTokenByValue as unknown as Mock).mockRejectedValue(new Error('Revocation failed'));

      const request = new Request('http://localhost/api/auth/logout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'accessToken=mock-access-token; refreshToken=mock-refresh-token',
          'X-CSRF-Token': 'mock-csrf-token',
          'X-Device-Token': 'mock-device-token',
        },
      });

      // Act
      const response = await POST(request);

      // Assert - logout should still succeed
      expect(response.status).toBe(200);
    });
  });

  describe('authentication', () => {
    it('returns error when not authenticated', async () => {
      // Arrange
      const mockError = { error: Response.json({ error: 'Unauthorized' }, { status: 401 }) };
      (authenticateRequestWithOptions as unknown as Mock).mockResolvedValue(mockError);
      (isAuthError as unknown as Mock).mockReturnValue(true);

      const request = new Request('http://localhost/api/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      // Act
      const response = await POST(request);

      // Assert
      expect(response.status).toBe(401);
    });

    it('requires CSRF token for cookie-based auth', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/logout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'accessToken=mock-access-token',
        },
      });

      // Act
      await POST(request);

      // Assert
      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        expect.objectContaining({
          requireCSRF: true,
        })
      );
    });
  });

  describe('edge cases', () => {
    it('handles missing refresh token cookie gracefully', async () => {
      // Arrange
      (parse as unknown as Mock).mockReturnValue({});

      const request = new Request('http://localhost/api/auth/logout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': 'mock-csrf-token',
        },
      });

      // Act
      const response = await POST(request);

      // Assert - logout should still succeed
      expect(response.status).toBe(200);
      expect(db.delete).not.toHaveBeenCalled();
    });

    it('handles refresh token not found in database gracefully', async () => {
      // Arrange
      (db.delete as unknown as Mock).mockReturnValue({
        where: vi.fn().mockRejectedValue(new Error('Token not found')),
      });

      const request = new Request('http://localhost/api/auth/logout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'accessToken=mock-access-token; refreshToken=mock-refresh-token',
          'X-CSRF-Token': 'mock-csrf-token',
        },
      });

      // Act
      const response = await POST(request);

      // Assert - logout should still succeed
      expect(response.status).toBe(200);
    });

    it('handles malformed body gracefully', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/logout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'accessToken=mock-access-token; refreshToken=mock-refresh-token',
          'X-CSRF-Token': 'mock-csrf-token',
        },
        body: 'not-json',
      });

      // Act
      const response = await POST(request);

      // Assert - logout should still succeed
      expect(response.status).toBe(200);
    });
  });
});
