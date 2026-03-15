/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for /api/integrations/google-calendar/sync
//
// Tests the route handler's contract for triggering Google Calendar sync.
// ============================================================================

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('@pagespace/lib/security', () => ({
  checkDistributedRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  DISTRIBUTED_RATE_LIMITS: { LOGIN: { maxAttempts: 5, windowMs: 900000 } },
}));

vi.mock('@/lib/integrations/google-calendar/sync-service', () => ({
  syncGoogleCalendar: vi.fn(),
}));

import { loggers } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { checkDistributedRateLimit } from '@pagespace/lib/security';
import { syncGoogleCalendar } from '@/lib/integrations/google-calendar/sync-service';
import { POST } from '../route';

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

describe('POST /api/integrations/google-calendar/sync', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(checkDistributedRateLimit).mockResolvedValue({ allowed: true, remaining: 4, retryAfter: 0 });
    vi.mocked(syncGoogleCalendar).mockResolvedValue({
      success: true,
      eventsCreated: 5,
      eventsUpdated: 3,
      eventsDeleted: 1,
    });
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/integrations/google-calendar/sync', {
        method: 'POST',
      });
      const response = await POST(request);

      expect(response.status).toBe(401);
    });

    it('should call authenticateRequestWithOptions with CSRF required', async () => {
      const request = new Request('https://example.com/api/integrations/google-calendar/sync', {
        method: 'POST',
      });
      await POST(request);

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['session'], requireCSRF: true }
      );
    });
  });

  describe('rate limiting', () => {
    it('should return 429 when rate limited', async () => {
      vi.mocked(checkDistributedRateLimit).mockResolvedValue({
        allowed: false,
        remaining: 0,
        retryAfter: 600,
      });

      const request = new Request('https://example.com/api/integrations/google-calendar/sync', {
        method: 'POST',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(429);
      expect(body.error).toContain('Too many sync requests');
      expect(body.retryAfter).toBe(600);
    });

    it('should check rate limit with user-specific key', async () => {
      const request = new Request('https://example.com/api/integrations/google-calendar/sync', {
        method: 'POST',
      });
      await POST(request);

      expect(checkDistributedRateLimit).toHaveBeenCalledWith(
        `gcal:sync:user:${mockUserId}`,
        expect.any(Object)
      );
    });
  });

  describe('success path', () => {
    it('should return sync results on success', async () => {
      const request = new Request('https://example.com/api/integrations/google-calendar/sync', {
        method: 'POST',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        success: true,
        eventsCreated: 5,
        eventsUpdated: 3,
        eventsDeleted: 1,
      });
    });

    it('should log sync request', async () => {
      const request = new Request('https://example.com/api/integrations/google-calendar/sync', {
        method: 'POST',
      });
      await POST(request);

      expect(loggers.api.info).toHaveBeenCalledWith(
        'Google Calendar sync requested',
        { userId: mockUserId }
      );
    });
  });

  describe('sync failure', () => {
    it('should return 500 when sync fails', async () => {
      vi.mocked(syncGoogleCalendar).mockResolvedValue({
        success: false,
        error: 'Connection expired',
        eventsCreated: 0,
        eventsUpdated: 0,
        eventsDeleted: 0,
      });

      const request = new Request('https://example.com/api/integrations/google-calendar/sync', {
        method: 'POST',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Connection expired');
      expect(body.eventsCreated).toBe(0);
    });

    it('should provide default error message when sync error is empty', async () => {
      vi.mocked(syncGoogleCalendar).mockResolvedValue({
        success: false,
        eventsCreated: 0,
        eventsUpdated: 0,
        eventsDeleted: 0,
      });

      const request = new Request('https://example.com/api/integrations/google-calendar/sync', {
        method: 'POST',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toContain('Sync could not be completed');
    });
  });

  describe('error handling', () => {
    it('should return 500 on unexpected error', async () => {
      vi.mocked(syncGoogleCalendar).mockRejectedValue(new Error('Network error'));

      const request = new Request('https://example.com/api/integrations/google-calendar/sync', {
        method: 'POST',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to trigger sync');
    });

    it('should log error on failure', async () => {
      const error = new Error('Network error');
      vi.mocked(syncGoogleCalendar).mockRejectedValue(error);

      const request = new Request('https://example.com/api/integrations/google-calendar/sync', {
        method: 'POST',
      });
      await POST(request);

      expect(loggers.api.error).toHaveBeenCalledWith(
        'Error triggering Google Calendar sync:',
        error
      );
    });
  });
});
