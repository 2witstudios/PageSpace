/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for GET /api/notifications
//
// Tests the route handler's contract for fetching user notifications.
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

vi.mock('@pagespace/lib', () => ({
  getUserNotifications: vi.fn(),
  getUnreadNotificationCount: vi.fn(),
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

vi.mock('@/lib/utils/query-params', () => ({
  parseBoundedIntParam: vi.fn(),
}));

import { NextResponse } from 'next/server';
import { GET } from '../route';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { getUserNotifications, getUnreadNotificationCount } from '@pagespace/lib';
import { loggers } from '@pagespace/lib/server';
import { parseBoundedIntParam } from '@/lib/utils/query-params';

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

// ============================================================================
// GET /api/notifications - Contract Tests
// ============================================================================

describe('GET /api/notifications', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(parseBoundedIntParam).mockReturnValue(50);
    vi.mocked(getUserNotifications).mockResolvedValue([]);
    vi.mocked(getUnreadNotificationCount).mockResolvedValue(0);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/notifications');
      const response = await GET(request);

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBe('Unauthorized');
    });

    it('should call authenticateRequestWithOptions with session-only auth', async () => {
      const request = new Request('https://example.com/api/notifications');
      await GET(request);

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['session'], requireCSRF: false }
      );
    });
  });

  describe('countOnly mode', () => {
    it('should return only count when countOnly=true', async () => {
      vi.mocked(getUnreadNotificationCount).mockResolvedValue(5);

      const request = new Request('https://example.com/api/notifications?countOnly=true');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({ count: 5 });
      expect(getUnreadNotificationCount).toHaveBeenCalledWith(mockUserId);
      expect(getUserNotifications).not.toHaveBeenCalled();
    });

    it('should not use countOnly mode when param is not "true"', async () => {
      vi.mocked(getUserNotifications).mockResolvedValue([]);
      vi.mocked(getUnreadNotificationCount).mockResolvedValue(0);

      const request = new Request('https://example.com/api/notifications?countOnly=false');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toHaveProperty('notifications');
      expect(body).toHaveProperty('unreadCount');
      expect(getUserNotifications).toHaveBeenCalled();
    });
  });

  describe('full mode', () => {
    it('should return notifications and unreadCount', async () => {
      const mockNotifications = [
        { id: 'notif_1', message: 'You were mentioned', read: false },
        { id: 'notif_2', message: 'Page shared', read: true },
      ];
      vi.mocked(getUserNotifications).mockResolvedValue(mockNotifications as any);
      vi.mocked(getUnreadNotificationCount).mockResolvedValue(1);

      const request = new Request('https://example.com/api/notifications');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.notifications).toEqual(mockNotifications);
      expect(body.unreadCount).toBe(1);
    });

    it('should return empty notifications when user has none', async () => {
      vi.mocked(getUserNotifications).mockResolvedValue([]);
      vi.mocked(getUnreadNotificationCount).mockResolvedValue(0);

      const request = new Request('https://example.com/api/notifications');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.notifications).toEqual([]);
      expect(body.unreadCount).toBe(0);
    });
  });

  describe('limit parameter', () => {
    it('should pass parsed limit to getUserNotifications', async () => {
      vi.mocked(parseBoundedIntParam).mockReturnValue(25);

      const request = new Request('https://example.com/api/notifications?limit=25');
      await GET(request);

      expect(getUserNotifications).toHaveBeenCalledWith(mockUserId, 25);
    });

    it('should use default limit when not specified', async () => {
      vi.mocked(parseBoundedIntParam).mockReturnValue(50);

      const request = new Request('https://example.com/api/notifications');
      await GET(request);

      expect(getUserNotifications).toHaveBeenCalledWith(mockUserId, 50);
    });

    it('should call parseBoundedIntParam with correct options', async () => {
      const request = new Request('https://example.com/api/notifications?limit=75');
      await GET(request);

      expect(parseBoundedIntParam).toHaveBeenCalledWith('75', {
        defaultValue: 50,
        min: 1,
        max: 100,
      });
    });
  });

  describe('error handling', () => {
    it('should return 500 when getUserNotifications throws', async () => {
      vi.mocked(getUserNotifications).mockRejectedValue(new Error('Database error'));

      const request = new Request('https://example.com/api/notifications');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch notifications');
    });

    it('should return 500 when getUnreadNotificationCount throws', async () => {
      vi.mocked(getUnreadNotificationCount).mockRejectedValue(new Error('Count failed'));

      const request = new Request('https://example.com/api/notifications?countOnly=true');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch notifications');
    });

    it('should log error when query fails', async () => {
      const error = new Error('Database error');
      vi.mocked(getUserNotifications).mockRejectedValue(error);

      const request = new Request('https://example.com/api/notifications');
      await GET(request);

      expect(loggers.api.error).toHaveBeenCalledWith(
        'Error fetching notifications:',
        error
      );
    });
  });
});
