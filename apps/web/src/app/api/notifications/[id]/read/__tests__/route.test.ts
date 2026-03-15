/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for PATCH /api/notifications/[id]/read
//
// Tests the route handler's contract for marking a notification as read.
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
  markNotificationAsRead: vi.fn(),
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
import { markNotificationAsRead } from '@pagespace/lib';
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
// PATCH /api/notifications/[id]/read - Contract Tests
// ============================================================================

describe('PATCH /api/notifications/[id]/read', () => {
  const mockUserId = 'user_123';
  const mockNotificationId = 'notif_abc';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(markNotificationAsRead).mockResolvedValue({
      id: mockNotificationId,
      userId: mockUserId,
      read: true,
    } as any);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/notifications/notif_abc/read', {
        method: 'PATCH',
      });
      const response = await PATCH(request, createContext(mockNotificationId));

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBe('Unauthorized');
    });

    it('should call authenticateRequestWithOptions with CSRF required', async () => {
      const request = new Request('https://example.com/api/notifications/notif_abc/read', {
        method: 'PATCH',
      });
      await PATCH(request, createContext(mockNotificationId));

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['session'], requireCSRF: true }
      );
    });
  });

  describe('successful mark as read', () => {
    it('should return the updated notification', async () => {
      const mockNotification = {
        id: mockNotificationId,
        userId: mockUserId,
        read: true,
        message: 'You were mentioned',
      };
      vi.mocked(markNotificationAsRead).mockResolvedValue(mockNotification as any);

      const request = new Request('https://example.com/api/notifications/notif_abc/read', {
        method: 'PATCH',
      });
      const response = await PATCH(request, createContext(mockNotificationId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual(mockNotification);
    });

    it('should call markNotificationAsRead with correct params', async () => {
      const request = new Request('https://example.com/api/notifications/notif_abc/read', {
        method: 'PATCH',
      });
      await PATCH(request, createContext(mockNotificationId));

      expect(markNotificationAsRead).toHaveBeenCalledWith(mockNotificationId, mockUserId);
    });

    it('should await context.params before using id', async () => {
      const request = new Request('https://example.com/api/notifications/notif_xyz/read', {
        method: 'PATCH',
      });
      await PATCH(request, createContext('notif_xyz'));

      expect(markNotificationAsRead).toHaveBeenCalledWith('notif_xyz', mockUserId);
    });
  });

  describe('notification not found', () => {
    it('should return 404 when notification does not exist', async () => {
      vi.mocked(markNotificationAsRead).mockResolvedValue(null as any);

      const request = new Request('https://example.com/api/notifications/notif_nonexistent/read', {
        method: 'PATCH',
      });
      const response = await PATCH(request, createContext('notif_nonexistent'));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Notification not found');
    });

    it('should not return 404 when notification exists', async () => {
      vi.mocked(markNotificationAsRead).mockResolvedValue({ id: 'notif_abc' } as any);

      const request = new Request('https://example.com/api/notifications/notif_abc/read', {
        method: 'PATCH',
      });
      const response = await PATCH(request, createContext(mockNotificationId));

      expect(response.status).toBe(200);
    });
  });

  describe('error handling', () => {
    it('should return 500 when markNotificationAsRead throws', async () => {
      vi.mocked(markNotificationAsRead).mockRejectedValue(new Error('Database error'));

      const request = new Request('https://example.com/api/notifications/notif_abc/read', {
        method: 'PATCH',
      });
      const response = await PATCH(request, createContext(mockNotificationId));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to mark notification as read');
    });

    it('should log error when markNotificationAsRead throws', async () => {
      const error = new Error('Database error');
      vi.mocked(markNotificationAsRead).mockRejectedValue(error);

      const request = new Request('https://example.com/api/notifications/notif_abc/read', {
        method: 'PATCH',
      });
      await PATCH(request, createContext(mockNotificationId));

      expect(loggers.api.error).toHaveBeenCalledWith(
        'Error marking notification as read:',
        error
      );
    });
  });
});
