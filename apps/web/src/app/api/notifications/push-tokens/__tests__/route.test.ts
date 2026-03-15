/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for /api/notifications/push-tokens
//
// Tests GET, POST, DELETE route handlers for push token management.
// Mocks auth and service-layer functions.
// ============================================================================

// Mock next/server before importing route
vi.mock('next/server', () => {
  class MockNextResponse extends Response {
    static json(data: unknown, init?: ResponseInit) {
      return new Response(JSON.stringify(data), {
        status: init?.status ?? 200,
        headers: {
          'Content-Type': 'application/json',
          ...(init?.headers || {}),
        },
      });
    }
  }
  return { NextResponse: MockNextResponse };
});

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@pagespace/lib/notifications', () => ({
  registerPushToken: vi.fn(),
  unregisterPushToken: vi.fn(),
  getUserPushTokens: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  },
}));

import { NextResponse } from 'next/server';
import { GET, POST, DELETE } from '../route';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { registerPushToken, unregisterPushToken, getUserPushTokens } from '@pagespace/lib/notifications';
import { loggers } from '@pagespace/lib/server';

// ============================================================================
// Test Helpers
// ============================================================================

const mockWebAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session-id',
  adminRoleVersion: 0,
  role: 'user',
});

const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

const createJsonRequest = (url: string, method: string, body?: object) => {
  const init: RequestInit = { method };
  if (body) {
    init.body = JSON.stringify(body);
    init.headers = { 'Content-Type': 'application/json' };
  }
  return new Request(url, init);
};

// ============================================================================
// GET /api/notifications/push-tokens - Contract Tests
// ============================================================================

describe('GET /api/notifications/push-tokens', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(getUserPushTokens).mockResolvedValue([]);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/notifications/push-tokens');
      const response = await GET(request);

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBe('Unauthorized');
    });

    it('should call authenticateRequestWithOptions with CSRF required', async () => {
      const request = new Request('https://example.com/api/notifications/push-tokens');
      await GET(request);

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['session'], requireCSRF: true }
      );
    });
  });

  describe('success', () => {
    it('should return tokens for the authenticated user', async () => {
      const mockTokens = [
        { id: 'token_1', token: 'abc123', platform: 'ios' },
        { id: 'token_2', token: 'def456', platform: 'web' },
      ];
      vi.mocked(getUserPushTokens).mockResolvedValue(mockTokens as any);

      const request = new Request('https://example.com/api/notifications/push-tokens');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.tokens).toEqual(mockTokens);
    });

    it('should return empty array when user has no tokens', async () => {
      vi.mocked(getUserPushTokens).mockResolvedValue([]);

      const request = new Request('https://example.com/api/notifications/push-tokens');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.tokens).toEqual([]);
    });

    it('should call getUserPushTokens with userId', async () => {
      const request = new Request('https://example.com/api/notifications/push-tokens');
      await GET(request);

      expect(getUserPushTokens).toHaveBeenCalledWith(mockUserId);
    });
  });

  describe('error handling', () => {
    it('should return 500 when getUserPushTokens throws', async () => {
      vi.mocked(getUserPushTokens).mockRejectedValue(new Error('Database error'));

      const request = new Request('https://example.com/api/notifications/push-tokens');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch push tokens');
    });

    it('should log error when getUserPushTokens throws', async () => {
      const error = new Error('Database error');
      vi.mocked(getUserPushTokens).mockRejectedValue(error);

      const request = new Request('https://example.com/api/notifications/push-tokens');
      await GET(request);

      expect(loggers.api.error).toHaveBeenCalledWith(
        'Error fetching push tokens:',
        error
      );
    });
  });
});

// ============================================================================
// POST /api/notifications/push-tokens - Contract Tests
// ============================================================================

describe('POST /api/notifications/push-tokens', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(registerPushToken).mockResolvedValue({ id: 'push_token_1' } as any);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = createJsonRequest(
        'https://example.com/api/notifications/push-tokens',
        'POST',
        { token: 'abc123', platform: 'ios' }
      );
      const response = await POST(request);

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBe('Unauthorized');
    });
  });

  describe('validation', () => {
    it('should return 400 when token is missing', async () => {
      const request = createJsonRequest(
        'https://example.com/api/notifications/push-tokens',
        'POST',
        { platform: 'ios' }
      );
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Token and platform are required');
    });

    it('should return 400 when platform is missing', async () => {
      const request = createJsonRequest(
        'https://example.com/api/notifications/push-tokens',
        'POST',
        { token: 'abc123' }
      );
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Token and platform are required');
    });

    it('should return 400 when both token and platform are missing', async () => {
      const request = createJsonRequest(
        'https://example.com/api/notifications/push-tokens',
        'POST',
        {}
      );
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Token and platform are required');
    });

    it('should return 400 when platform is invalid', async () => {
      const request = createJsonRequest(
        'https://example.com/api/notifications/push-tokens',
        'POST',
        { token: 'abc123', platform: 'windows' }
      );
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid platform. Must be ios, android, or web');
    });

    it('should accept ios platform', async () => {
      const request = createJsonRequest(
        'https://example.com/api/notifications/push-tokens',
        'POST',
        { token: 'abc123', platform: 'ios' }
      );
      const response = await POST(request);

      expect(response.status).toBe(200);
    });

    it('should accept android platform', async () => {
      const request = createJsonRequest(
        'https://example.com/api/notifications/push-tokens',
        'POST',
        { token: 'abc123', platform: 'android' }
      );
      const response = await POST(request);

      expect(response.status).toBe(200);
    });

    it('should accept web platform', async () => {
      const request = createJsonRequest(
        'https://example.com/api/notifications/push-tokens',
        'POST',
        { token: 'abc123', platform: 'web' }
      );
      const response = await POST(request);

      expect(response.status).toBe(200);
    });
  });

  describe('successful registration', () => {
    it('should return success with tokenId', async () => {
      vi.mocked(registerPushToken).mockResolvedValue({ id: 'push_token_42' } as any);

      const request = createJsonRequest(
        'https://example.com/api/notifications/push-tokens',
        'POST',
        { token: 'abc123', platform: 'ios' }
      );
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({ success: true, tokenId: 'push_token_42' });
    });

    it('should call registerPushToken with all provided params', async () => {
      const request = createJsonRequest(
        'https://example.com/api/notifications/push-tokens',
        'POST',
        {
          token: 'abc123',
          platform: 'ios',
          deviceId: 'device_1',
          deviceName: 'iPhone 15',
          webPushSubscription: { endpoint: 'https://push.example.com' },
        }
      );
      await POST(request);

      expect(registerPushToken).toHaveBeenCalledWith(
        mockUserId,
        'abc123',
        'ios',
        'device_1',
        'iPhone 15',
        { endpoint: 'https://push.example.com' }
      );
    });

    it('should call registerPushToken with undefined for optional params', async () => {
      const request = createJsonRequest(
        'https://example.com/api/notifications/push-tokens',
        'POST',
        { token: 'abc123', platform: 'web' }
      );
      await POST(request);

      expect(registerPushToken).toHaveBeenCalledWith(
        mockUserId,
        'abc123',
        'web',
        undefined,
        undefined,
        undefined
      );
    });
  });

  describe('error handling', () => {
    it('should return 500 when registerPushToken throws', async () => {
      vi.mocked(registerPushToken).mockRejectedValue(new Error('Database error'));

      const request = createJsonRequest(
        'https://example.com/api/notifications/push-tokens',
        'POST',
        { token: 'abc123', platform: 'ios' }
      );
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to register push token');
    });

    it('should log error when registerPushToken throws', async () => {
      const error = new Error('Database error');
      vi.mocked(registerPushToken).mockRejectedValue(error);

      const request = createJsonRequest(
        'https://example.com/api/notifications/push-tokens',
        'POST',
        { token: 'abc123', platform: 'ios' }
      );
      await POST(request);

      expect(loggers.api.error).toHaveBeenCalledWith(
        'Error registering push token:',
        error
      );
    });
  });
});

// ============================================================================
// DELETE /api/notifications/push-tokens - Contract Tests
// ============================================================================

describe('DELETE /api/notifications/push-tokens', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(unregisterPushToken).mockResolvedValue(undefined);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = createJsonRequest(
        'https://example.com/api/notifications/push-tokens',
        'DELETE',
        { token: 'abc123' }
      );
      const response = await DELETE(request);

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBe('Unauthorized');
    });
  });

  describe('validation', () => {
    it('should return 400 when token is missing', async () => {
      const request = createJsonRequest(
        'https://example.com/api/notifications/push-tokens',
        'DELETE',
        {}
      );
      const response = await DELETE(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Token is required');
    });
  });

  describe('successful unregistration', () => {
    it('should return success response', async () => {
      const request = createJsonRequest(
        'https://example.com/api/notifications/push-tokens',
        'DELETE',
        { token: 'abc123' }
      );
      const response = await DELETE(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({ success: true });
    });

    it('should call unregisterPushToken with correct params', async () => {
      const request = createJsonRequest(
        'https://example.com/api/notifications/push-tokens',
        'DELETE',
        { token: 'abc123' }
      );
      await DELETE(request);

      expect(unregisterPushToken).toHaveBeenCalledWith(mockUserId, 'abc123');
    });
  });

  describe('error handling', () => {
    it('should return 500 when unregisterPushToken throws', async () => {
      vi.mocked(unregisterPushToken).mockRejectedValue(new Error('Database error'));

      const request = createJsonRequest(
        'https://example.com/api/notifications/push-tokens',
        'DELETE',
        { token: 'abc123' }
      );
      const response = await DELETE(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to unregister push token');
    });

    it('should log error when unregisterPushToken throws', async () => {
      const error = new Error('Database error');
      vi.mocked(unregisterPushToken).mockRejectedValue(error);

      const request = createJsonRequest(
        'https://example.com/api/notifications/push-tokens',
        'DELETE',
        { token: 'abc123' }
      );
      await DELETE(request);

      expect(loggers.api.error).toHaveBeenCalledWith(
        'Error unregistering push token:',
        error
      );
    });
  });
});
