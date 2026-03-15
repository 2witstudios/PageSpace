/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for /api/integrations/google-calendar/settings
//
// Tests the GET and PATCH route handlers for Google Calendar sync settings.
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
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn().mockResolvedValue(undefined),
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
import { GET, PATCH } from '../route';

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

describe('GET /api/integrations/google-calendar/settings', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/integrations/google-calendar/settings');
      const response = await GET(request);

      expect(response.status).toBe(401);
    });

    it('should call authenticateRequestWithOptions without CSRF for GET', async () => {
      vi.mocked(db.query.googleCalendarConnections.findFirst).mockResolvedValue(null);

      const request = new Request('https://example.com/api/integrations/google-calendar/settings');
      await GET(request);

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['session'], requireCSRF: false }
      );
    });
  });

  describe('when no connection exists', () => {
    it('should return 404', async () => {
      vi.mocked(db.query.googleCalendarConnections.findFirst).mockResolvedValue(null);

      const request = new Request('https://example.com/api/integrations/google-calendar/settings');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('No connection found');
    });
  });

  describe('success path', () => {
    it('should return settings and stats', async () => {
      vi.mocked(db.query.googleCalendarConnections.findFirst).mockResolvedValue({
        selectedCalendars: ['user@gmail.com'],
        syncFrequencyMinutes: 15,
        targetDriveId: 'drive_1',
        lastSyncAt: new Date('2024-01-15'),
      });

      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ total: 25 }]),
        }),
      } as any);

      const request = new Request('https://example.com/api/integrations/google-calendar/settings');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.settings).toMatchObject({
        selectedCalendars: ['user@gmail.com'],
        syncFrequencyMinutes: 15,
        targetDriveId: 'drive_1',
      });
      expect(body.stats.syncedEventCount).toBe(25);
    });

    it('should return 0 synced count when no events', async () => {
      vi.mocked(db.query.googleCalendarConnections.findFirst).mockResolvedValue({
        selectedCalendars: [],
        syncFrequencyMinutes: 30,
        targetDriveId: null,
        lastSyncAt: null,
      });

      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([undefined]),
        }),
      } as any);

      const request = new Request('https://example.com/api/integrations/google-calendar/settings');
      const response = await GET(request);
      const body = await response.json();

      expect(body.stats.syncedEventCount).toBe(0);
    });
  });

  describe('error handling', () => {
    it('should return 500 on database error', async () => {
      vi.mocked(db.query.googleCalendarConnections.findFirst).mockRejectedValue(new Error('DB error'));

      const request = new Request('https://example.com/api/integrations/google-calendar/settings');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch settings');
    });
  });
});

describe('PATCH /api/integrations/google-calendar/settings', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(db.query.googleCalendarConnections.findFirst).mockResolvedValue({
      id: 'conn_1',
      status: 'active',
    });
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    } as any);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/integrations/google-calendar/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ syncFrequencyMinutes: 30 }),
      });
      const response = await PATCH(request);

      expect(response.status).toBe(401);
    });

    it('should call authenticateRequestWithOptions with CSRF for PATCH', async () => {
      const request = new Request('https://example.com/api/integrations/google-calendar/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ syncFrequencyMinutes: 30 }),
      });
      await PATCH(request);

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['session'], requireCSRF: true }
      );
    });
  });

  describe('validation', () => {
    it('should return 400 for invalid syncFrequencyMinutes (too low)', async () => {
      const request = new Request('https://example.com/api/integrations/google-calendar/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ syncFrequencyMinutes: 2 }),
      });
      const response = await PATCH(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid settings');
    });

    it('should return 400 for invalid syncFrequencyMinutes (too high)', async () => {
      const request = new Request('https://example.com/api/integrations/google-calendar/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ syncFrequencyMinutes: 9999 }),
      });
      const response = await PATCH(request);

      expect(response.status).toBe(400);
    });

    it('should accept valid syncFrequencyMinutes', async () => {
      const request = new Request('https://example.com/api/integrations/google-calendar/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ syncFrequencyMinutes: 60 }),
      });
      const response = await PATCH(request);

      expect(response.status).toBe(200);
    });
  });

  describe('connection check', () => {
    it('should return 404 when no connection found', async () => {
      vi.mocked(db.query.googleCalendarConnections.findFirst).mockResolvedValue(null);

      const request = new Request('https://example.com/api/integrations/google-calendar/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ syncFrequencyMinutes: 30 }),
      });
      const response = await PATCH(request);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('No connection found');
    });
  });

  describe('success path', () => {
    it('should update selectedCalendars', async () => {
      const request = new Request('https://example.com/api/integrations/google-calendar/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selectedCalendars: ['cal1', 'cal2'] }),
      });
      const response = await PATCH(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(db.update).toHaveBeenCalled();
    });

    it('should update targetDriveId to null', async () => {
      const request = new Request('https://example.com/api/integrations/google-calendar/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetDriveId: null }),
      });
      const response = await PATCH(request);

      expect(response.status).toBe(200);
    });

    it('should log successful update', async () => {
      const request = new Request('https://example.com/api/integrations/google-calendar/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ syncFrequencyMinutes: 30 }),
      });
      await PATCH(request);

      expect(loggers.api.info).toHaveBeenCalledWith(
        'Google Calendar settings updated',
        expect.objectContaining({ userId: mockUserId })
      );
    });
  });

  describe('error handling', () => {
    it('should return 500 on database update error', async () => {
      vi.mocked(db.update).mockImplementation(() => {
        throw new Error('DB error');
      });

      const request = new Request('https://example.com/api/integrations/google-calendar/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ syncFrequencyMinutes: 30 }),
      });
      const response = await PATCH(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to update settings');
    });
  });
});
