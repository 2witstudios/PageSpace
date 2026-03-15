/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for /api/integrations/google-calendar/status
//
// Tests the route handler's contract for returning Google Calendar connection
// status for the authenticated user.
// ============================================================================

vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      googleCalendarConnections: { findFirst: vi.fn() },
    },
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue([{ total: 0 }]),
      })),
    })),
  },
  googleCalendarConnections: { userId: 'userId' },
  calendarEvents: {
    createdById: 'createdById',
    syncedFromGoogle: 'syncedFromGoogle',
    isTrashed: 'isTrashed',
  },
  eq: vi.fn(),
  and: vi.fn(),
  count: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

import { db } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
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

describe('GET /api/integrations/google-calendar/status', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(db.query.googleCalendarConnections.findFirst).mockResolvedValue(null);
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ total: 0 }]),
      }),
    } as any);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/integrations/google-calendar/status');
      const response = await GET(request);

      expect(response.status).toBe(401);
    });

    it('should call authenticateRequestWithOptions with correct auth options', async () => {
      const request = new Request('https://example.com/api/integrations/google-calendar/status');
      await GET(request);

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['session'], requireCSRF: false }
      );
    });
  });

  describe('when no connection exists', () => {
    it('should return connected=false with null connection', async () => {
      vi.mocked(db.query.googleCalendarConnections.findFirst).mockResolvedValue(null);

      const request = new Request('https://example.com/api/integrations/google-calendar/status');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({
        connected: false,
        connection: null,
        syncedEventCount: 0,
      });
    });
  });

  describe('when connection exists', () => {
    const mockConnection = {
      id: 'conn_1',
      status: 'active',
      statusMessage: null,
      googleEmail: 'user@gmail.com',
      selectedCalendars: ['user@gmail.com'],
      syncFrequencyMinutes: 15,
      targetDriveId: 'drive_1',
      lastSyncAt: new Date('2024-01-15'),
      lastSyncError: null,
      createdAt: new Date('2024-01-01'),
      updatedAt: new Date('2024-01-15'),
    };

    it('should return connected=true for active connection', async () => {
      vi.mocked(db.query.googleCalendarConnections.findFirst).mockResolvedValue(mockConnection);

      const request = new Request('https://example.com/api/integrations/google-calendar/status');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.connected).toBe(true);
      expect(body.connection).toMatchObject({
        id: 'conn_1',
        status: 'active',
        googleEmail: 'user@gmail.com',
      });
    });

    it('should return connected=false for disconnected connection', async () => {
      vi.mocked(db.query.googleCalendarConnections.findFirst).mockResolvedValue({
        ...mockConnection,
        status: 'disconnected',
      });

      const request = new Request('https://example.com/api/integrations/google-calendar/status');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.connected).toBe(false);
    });

    it('should include synced event count', async () => {
      vi.mocked(db.query.googleCalendarConnections.findFirst).mockResolvedValue(mockConnection);
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ total: 42 }]),
        }),
      } as any);

      const request = new Request('https://example.com/api/integrations/google-calendar/status');
      const response = await GET(request);
      const body = await response.json();

      expect(body.syncedEventCount).toBe(42);
    });

    it('should return 0 synced event count when no stats', async () => {
      vi.mocked(db.query.googleCalendarConnections.findFirst).mockResolvedValue(mockConnection);
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([undefined]),
        }),
      } as any);

      const request = new Request('https://example.com/api/integrations/google-calendar/status');
      const response = await GET(request);
      const body = await response.json();

      expect(body.syncedEventCount).toBe(0);
    });
  });

  describe('error handling', () => {
    it('should return 500 when database query fails', async () => {
      vi.mocked(db.query.googleCalendarConnections.findFirst).mockRejectedValue(
        new Error('Database error')
      );

      const request = new Request('https://example.com/api/integrations/google-calendar/status');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch connection status');
    });

    it('should log error when query fails', async () => {
      const error = new Error('Database error');
      vi.mocked(db.query.googleCalendarConnections.findFirst).mockRejectedValue(error);

      const request = new Request('https://example.com/api/integrations/google-calendar/status');
      await GET(request);

      expect(loggers.api.error).toHaveBeenCalledWith(
        'Error fetching Google Calendar status:',
        error
      );
    });
  });
});
