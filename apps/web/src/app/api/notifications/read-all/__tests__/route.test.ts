/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for PATCH /api/notifications/read-all
//
// Tests the route handler's contract for marking all notifications as read.
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
  markAllNotificationsAsRead: vi.fn(),
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
import { PATCH } from '../route';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { markAllNotificationsAsRead } from '@pagespace/lib';
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

// ============================================================================
// PATCH /api/notifications/read-all - Contract Tests
// ============================================================================

describe('PATCH /api/notifications/read-all', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(markAllNotificationsAsRead).mockResolvedValue(undefined);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/notifications/read-all', {
        method: 'PATCH',
      });
      const response = await PATCH(request);

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBe('Unauthorized');
    });

    it('should call authenticateRequestWithOptions with CSRF required', async () => {
      const request = new Request('https://example.com/api/notifications/read-all', {
        method: 'PATCH',
      });
      await PATCH(request);

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['session'], requireCSRF: true }
      );
    });
  });

  describe('successful mark all as read', () => {
    it('should return success response', async () => {
      const request = new Request('https://example.com/api/notifications/read-all', {
        method: 'PATCH',
      });
      const response = await PATCH(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({ success: true });
    });

    it('should call markAllNotificationsAsRead with userId', async () => {
      const request = new Request('https://example.com/api/notifications/read-all', {
        method: 'PATCH',
      });
      await PATCH(request);

      expect(markAllNotificationsAsRead).toHaveBeenCalledWith(mockUserId);
    });

    it('should use the authenticated userId', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth('user_456'));

      const request = new Request('https://example.com/api/notifications/read-all', {
        method: 'PATCH',
      });
      await PATCH(request);

      expect(markAllNotificationsAsRead).toHaveBeenCalledWith('user_456');
    });
  });

  describe('error handling', () => {
    it('should return 500 when markAllNotificationsAsRead throws', async () => {
      vi.mocked(markAllNotificationsAsRead).mockRejectedValue(new Error('Database error'));

      const request = new Request('https://example.com/api/notifications/read-all', {
        method: 'PATCH',
      });
      const response = await PATCH(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to mark all notifications as read');
    });

    it('should log error when markAllNotificationsAsRead throws', async () => {
      const error = new Error('Database error');
      vi.mocked(markAllNotificationsAsRead).mockRejectedValue(error);

      const request = new Request('https://example.com/api/notifications/read-all', {
        method: 'PATCH',
      });
      await PATCH(request);

      expect(loggers.api.error).toHaveBeenCalledWith(
        'Error marking all notifications as read:',
        error
      );
    });
  });
});
