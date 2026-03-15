/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';

// ============================================================================
// Contract Tests for /api/cron/calendar-sync
//
// Tests automatic background Google Calendar sync for due connections.
// ============================================================================

vi.mock('@/lib/auth/cron-auth', () => ({
  validateSignedCronRequest: vi.fn(),
}));

vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      googleCalendarConnections: {
        findMany: vi.fn(),
      },
    },
  },
  googleCalendarConnections: {
    status: 'status',
    lastSyncAt: 'lastSyncAt',
    syncFrequencyMinutes: 'syncFrequencyMinutes',
  },
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  lt: vi.fn(),
  isNull: vi.fn(),
  sql: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('@/lib/integrations/google-calendar/sync-service', () => ({
  syncGoogleCalendar: vi.fn(),
}));

import { GET, POST } from '../route';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';
import { db } from '@pagespace/db';
import { syncGoogleCalendar } from '@/lib/integrations/google-calendar/sync-service';
import { loggers } from '@pagespace/lib/server';

// ============================================================================
// GET /api/cron/calendar-sync - Contract Tests
// ============================================================================

describe('GET /api/cron/calendar-sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateSignedCronRequest).mockReturnValue(null);
    vi.mocked(db.query.googleCalendarConnections.findMany).mockResolvedValue([]);
  });

  describe('authentication', () => {
    it('should return auth error when cron request is invalid', async () => {
      const errorResponse = NextResponse.json(
        { error: 'Forbidden' },
        { status: 403 }
      );
      vi.mocked(validateSignedCronRequest).mockReturnValue(errorResponse);

      const request = new Request('http://localhost/api/cron/calendar-sync');
      const response = await GET(request);

      expect(response.status).toBe(403);
    });
  });

  describe('success - no connections due', () => {
    it('should return success with 0 synced when no connections are due', async () => {
      const request = new Request('http://localhost/api/cron/calendar-sync');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.synced).toBe(0);
      expect(body.failed).toBe(0);
      expect(body.errors).toBeUndefined();
      expect(body.timestamp).toBeDefined();
    });
  });

  describe('success - with due connections', () => {
    it('should sync all due connections successfully', async () => {
      vi.mocked(db.query.googleCalendarConnections.findMany).mockResolvedValue([
        { userId: 'user_1', syncFrequencyMinutes: 15, lastSyncAt: null },
        { userId: 'user_2', syncFrequencyMinutes: 30, lastSyncAt: null },
      ] as any);
      vi.mocked(syncGoogleCalendar).mockResolvedValue({ success: true } as any);

      const request = new Request('http://localhost/api/cron/calendar-sync');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.synced).toBe(2);
      expect(body.failed).toBe(0);
      expect(body.errors).toBeUndefined();
    });

    it('should count failed syncs when syncGoogleCalendar returns failure', async () => {
      vi.mocked(db.query.googleCalendarConnections.findMany).mockResolvedValue([
        { userId: 'user_1', syncFrequencyMinutes: 15, lastSyncAt: null },
      ] as any);
      vi.mocked(syncGoogleCalendar).mockResolvedValue({
        success: false,
        error: 'Token expired',
      } as any);

      const request = new Request('http://localhost/api/cron/calendar-sync');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.synced).toBe(0);
      expect(body.failed).toBe(1);
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0].error).toBe('Token expired');
    });

    it('should handle thrown exceptions during sync', async () => {
      vi.mocked(db.query.googleCalendarConnections.findMany).mockResolvedValue([
        { userId: 'user_1', syncFrequencyMinutes: 15, lastSyncAt: null },
      ] as any);
      vi.mocked(syncGoogleCalendar).mockRejectedValue(new Error('API unreachable'));

      const request = new Request('http://localhost/api/cron/calendar-sync');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.synced).toBe(0);
      expect(body.failed).toBe(1);
      expect(body.errors[0].error).toBe('API unreachable');
    });

    it('should mix success and failure counts', async () => {
      vi.mocked(db.query.googleCalendarConnections.findMany).mockResolvedValue([
        { userId: 'user_1', syncFrequencyMinutes: 15, lastSyncAt: null },
        { userId: 'user_2', syncFrequencyMinutes: 30, lastSyncAt: null },
        { userId: 'user_3', syncFrequencyMinutes: 60, lastSyncAt: null },
      ] as any);
      vi.mocked(syncGoogleCalendar)
        .mockResolvedValueOnce({ success: true } as any)
        .mockResolvedValueOnce({ success: false, error: 'Auth error' } as any)
        .mockRejectedValueOnce(new Error('Network error'));

      const request = new Request('http://localhost/api/cron/calendar-sync');
      const response = await GET(request);
      const body = await response.json();

      expect(body.synced).toBe(1);
      expect(body.failed).toBe(2);
      expect(body.errors).toHaveLength(2);
    });

    it('should log errors for failed syncs', async () => {
      vi.mocked(db.query.googleCalendarConnections.findMany).mockResolvedValue([
        { userId: 'user_1', syncFrequencyMinutes: 15, lastSyncAt: null },
      ] as any);
      vi.mocked(syncGoogleCalendar).mockResolvedValue({
        success: false,
        error: 'Token expired',
      } as any);

      const request = new Request('http://localhost/api/cron/calendar-sync');
      await GET(request);

      expect(loggers.api.error).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should return 500 when database query throws', async () => {
      vi.mocked(db.query.googleCalendarConnections.findMany).mockRejectedValue(
        new Error('DB connection failed')
      );

      const request = new Request('http://localhost/api/cron/calendar-sync');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.success).toBe(false);
      expect(body.error).toBe('DB connection failed');
    });

    it('should return "Unknown error" for non-Error throws', async () => {
      vi.mocked(db.query.googleCalendarConnections.findMany).mockRejectedValue('fail');

      const request = new Request('http://localhost/api/cron/calendar-sync');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Unknown error');
    });
  });
});

// ============================================================================
// POST /api/cron/calendar-sync - Delegates to GET
// ============================================================================

describe('POST /api/cron/calendar-sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateSignedCronRequest).mockReturnValue(null);
    vi.mocked(db.query.googleCalendarConnections.findMany).mockResolvedValue([]);
  });

  it('should delegate to GET handler', async () => {
    const request = new Request('http://localhost/api/cron/calendar-sync', { method: 'POST' });
    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.synced).toBe(0);
  });
});
