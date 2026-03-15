/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for /api/integrations/google-calendar/calendars
//
// Tests the route handler's contract for listing Google calendars
// available to the authenticated user.
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

vi.mock('@/lib/integrations/google-calendar/token-refresh', () => ({
  getValidAccessToken: vi.fn(),
}));

vi.mock('@/lib/integrations/google-calendar/api-client', () => ({
  listCalendars: vi.fn(),
}));

import { loggers } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { getValidAccessToken } from '@/lib/integrations/google-calendar/token-refresh';
import { listCalendars } from '@/lib/integrations/google-calendar/api-client';
import { GET } from '../route';

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

describe('GET /api/integrations/google-calendar/calendars', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(getValidAccessToken).mockResolvedValue({
      success: true,
      accessToken: 'valid-token',
    });
    vi.mocked(listCalendars).mockResolvedValue({
      success: true,
      data: [],
    });
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/integrations/google-calendar/calendars');
      const response = await GET(request);

      expect(response.status).toBe(401);
    });

    it('should call authenticateRequestWithOptions with correct auth options', async () => {
      const request = new Request('https://example.com/api/integrations/google-calendar/calendars');
      await GET(request);

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['session'], requireCSRF: false }
      );
    });
  });

  describe('token validation', () => {
    it('should return 401 when token requires reauth', async () => {
      vi.mocked(getValidAccessToken).mockResolvedValue({
        success: false,
        error: 'Token expired',
        requiresReauth: true,
      });

      const request = new Request('https://example.com/api/integrations/google-calendar/calendars');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Token expired');
      expect(body.requiresReauth).toBe(true);
    });

    it('should return 500 when token refresh fails without reauth', async () => {
      vi.mocked(getValidAccessToken).mockResolvedValue({
        success: false,
        error: 'Token refresh failed',
        requiresReauth: false,
      });

      const request = new Request('https://example.com/api/integrations/google-calendar/calendars');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Token refresh failed');
    });
  });

  describe('calendar listing', () => {
    it('should return empty calendars list', async () => {
      vi.mocked(listCalendars).mockResolvedValue({
        success: true,
        data: [],
      });

      const request = new Request('https://example.com/api/integrations/google-calendar/calendars');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.calendars).toEqual([]);
    });

    it('should return calendars with correct shape', async () => {
      vi.mocked(listCalendars).mockResolvedValue({
        success: true,
        data: [
          {
            id: 'cal_1',
            summary: 'Work Calendar',
            description: 'My work events',
            timeZone: 'America/New_York',
            backgroundColor: '#3F51B5',
            foregroundColor: '#FFFFFF',
            primary: false,
            accessRole: 'owner',
          },
        ],
      });

      const request = new Request('https://example.com/api/integrations/google-calendar/calendars');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.calendars).toHaveLength(1);
      expect(body.calendars[0]).toMatchObject({
        id: 'cal_1',
        summary: 'Work Calendar',
        description: 'My work events',
        timeZone: 'America/New_York',
        backgroundColor: '#3F51B5',
        foregroundColor: '#FFFFFF',
        primary: false,
        accessRole: 'owner',
      });
    });

    it('should sort primary calendar first', async () => {
      vi.mocked(listCalendars).mockResolvedValue({
        success: true,
        data: [
          { id: 'cal_2', summary: 'Work', primary: false, accessRole: 'owner' },
          { id: 'cal_1', summary: 'Primary', primary: true, accessRole: 'owner' },
        ],
      });

      const request = new Request('https://example.com/api/integrations/google-calendar/calendars');
      const response = await GET(request);
      const body = await response.json();

      expect(body.calendars[0].id).toBe('cal_1');
      expect(body.calendars[0].primary).toBe(true);
    });

    it('should sort non-primary calendars by summary', async () => {
      vi.mocked(listCalendars).mockResolvedValue({
        success: true,
        data: [
          { id: 'cal_b', summary: 'Zebra', primary: false, accessRole: 'reader' },
          { id: 'cal_a', summary: 'Alpha', primary: false, accessRole: 'reader' },
        ],
      });

      const request = new Request('https://example.com/api/integrations/google-calendar/calendars');
      const response = await GET(request);
      const body = await response.json();

      expect(body.calendars[0].summary).toBe('Alpha');
      expect(body.calendars[1].summary).toBe('Zebra');
    });

    it('should return error status from Google API', async () => {
      vi.mocked(listCalendars).mockResolvedValue({
        success: false,
        error: 'API quota exceeded',
        statusCode: 429,
      });

      const request = new Request('https://example.com/api/integrations/google-calendar/calendars');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(429);
      expect(body.error).toBe('API quota exceeded');
    });

    it('should default to 500 when Google API error has no status code', async () => {
      vi.mocked(listCalendars).mockResolvedValue({
        success: false,
        error: 'Unknown error',
      });

      const request = new Request('https://example.com/api/integrations/google-calendar/calendars');
      const response = await GET(request);

      expect(response.status).toBe(500);
    });
  });

  describe('error handling', () => {
    it('should return 500 when unexpected error occurs', async () => {
      vi.mocked(getValidAccessToken).mockRejectedValue(new Error('Unexpected'));

      const request = new Request('https://example.com/api/integrations/google-calendar/calendars');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch calendars');
    });

    it('should log error when request fails', async () => {
      const error = new Error('Unexpected');
      vi.mocked(getValidAccessToken).mockRejectedValue(error);

      const request = new Request('https://example.com/api/integrations/google-calendar/calendars');
      await GET(request);

      expect(loggers.api.error).toHaveBeenCalledWith(
        'Error fetching Google calendars:',
        error
      );
    });
  });
});
