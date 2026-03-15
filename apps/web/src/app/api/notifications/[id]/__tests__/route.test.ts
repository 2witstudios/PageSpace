/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for DELETE /api/notifications/[id]
//
// Tests the route handler's contract for deleting a notification.
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
  deleteNotification: vi.fn(),
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
import { DELETE } from '../route';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { deleteNotification } from '@pagespace/lib';
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

const createContext = (id: string) => ({
  params: Promise.resolve({ id }),
});

// ============================================================================
// DELETE /api/notifications/[id] - Contract Tests
// ============================================================================

describe('DELETE /api/notifications/[id]', () => {
  const mockUserId = 'user_123';
  const mockNotificationId = 'notif_abc';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(deleteNotification).mockResolvedValue(undefined);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/notifications/notif_abc', {
        method: 'DELETE',
      });
      const response = await DELETE(request, createContext(mockNotificationId));

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBe('Unauthorized');
    });

    it('should call authenticateRequestWithOptions with CSRF required', async () => {
      const request = new Request('https://example.com/api/notifications/notif_abc', {
        method: 'DELETE',
      });
      await DELETE(request, createContext(mockNotificationId));

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['session'], requireCSRF: true }
      );
    });
  });

  describe('successful deletion', () => {
    it('should return success when notification is deleted', async () => {
      const request = new Request('https://example.com/api/notifications/notif_abc', {
        method: 'DELETE',
      });
      const response = await DELETE(request, createContext(mockNotificationId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({ success: true });
    });

    it('should call deleteNotification with correct params', async () => {
      const request = new Request('https://example.com/api/notifications/notif_abc', {
        method: 'DELETE',
      });
      await DELETE(request, createContext(mockNotificationId));

      expect(deleteNotification).toHaveBeenCalledWith(mockNotificationId, mockUserId);
    });

    it('should await context.params before using id', async () => {
      const request = new Request('https://example.com/api/notifications/notif_xyz', {
        method: 'DELETE',
      });
      await DELETE(request, createContext('notif_xyz'));

      expect(deleteNotification).toHaveBeenCalledWith('notif_xyz', mockUserId);
    });
  });

  describe('error handling', () => {
    it('should return 500 when deleteNotification throws', async () => {
      vi.mocked(deleteNotification).mockRejectedValue(new Error('Database error'));

      const request = new Request('https://example.com/api/notifications/notif_abc', {
        method: 'DELETE',
      });
      const response = await DELETE(request, createContext(mockNotificationId));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to delete notification');
    });

    it('should log error when deleteNotification throws', async () => {
      const error = new Error('Database error');
      vi.mocked(deleteNotification).mockRejectedValue(error);

      const request = new Request('https://example.com/api/notifications/notif_abc', {
        method: 'DELETE',
      });
      await DELETE(request, createContext(mockNotificationId));

      expect(loggers.api.error).toHaveBeenCalledWith(
        'Error deleting notification:',
        error
      );
    });
  });
});
