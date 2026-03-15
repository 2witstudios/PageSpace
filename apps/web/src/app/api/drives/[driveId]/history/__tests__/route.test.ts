import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for /api/drives/[driveId]/history
//
// Tests mock at the SERVICE SEAM level, not ORM level.
// ============================================================================

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

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@pagespace/lib', () => ({
  isDriveOwnerOrAdmin: vi.fn(),
}));

vi.mock('@/services/api', () => ({
  getDriveVersionHistory: vi.fn(),
  getUserRetentionDays: vi.fn(),
}));

vi.mock('@pagespace/lib/permissions', () => ({
  isActivityEligibleForRollback: vi.fn(),
}));

vi.mock('@/lib/logging/mask', () => ({
  maskIdentifier: vi.fn((id) => `***${id?.slice(-4)}`),
}));

import { GET } from '../route';
import { loggers } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { isDriveOwnerOrAdmin } from '@pagespace/lib';
import { getDriveVersionHistory, getUserRetentionDays } from '@/services/api';
import { isActivityEligibleForRollback } from '@pagespace/lib/permissions';

// ============================================================================
// Test Helpers
// ============================================================================

const mockWebAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session-id',
  role: 'user',
  adminRoleVersion: 0,
});

const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

const createContext = (driveId: string) => ({
  params: Promise.resolve({ driveId }),
});

// ============================================================================
// GET /api/drives/[driveId]/history - Contract Tests
// ============================================================================

describe('GET /api/drives/[driveId]/history', () => {
  const mockUserId = 'user_123';
  const mockDriveId = 'drive_abc';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(isDriveOwnerOrAdmin).mockResolvedValue(true);
    vi.mocked(getUserRetentionDays).mockResolvedValue(-1); // unlimited by default
    vi.mocked(getDriveVersionHistory).mockResolvedValue({ activities: [], total: 0 });
    vi.mocked(isActivityEligibleForRollback).mockReturnValue(false);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/history`);
      const response = await GET(request, createContext(mockDriveId));

      expect(response.status).toBe(401);
    });

    it('should call authenticateRequestWithOptions with session-only read options', async () => {
      const request = new Request(`https://example.com/api/drives/${mockDriveId}/history`);
      await GET(request, createContext(mockDriveId));

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['session'], requireCSRF: false }
      );
    });
  });

  describe('authorization', () => {
    it('should return 403 when user is not drive owner or admin', async () => {
      vi.mocked(isDriveOwnerOrAdmin).mockResolvedValue(false);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/history`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Unauthorized - only drive owners and admins can view drive history');
    });

    it('should call isDriveOwnerOrAdmin with userId and driveId', async () => {
      const request = new Request(`https://example.com/api/drives/${mockDriveId}/history`);
      await GET(request, createContext(mockDriveId));

      expect(isDriveOwnerOrAdmin).toHaveBeenCalledWith(mockUserId, mockDriveId);
    });
  });

  describe('query parameter validation', () => {
    it('should accept valid query parameters', async () => {
      const request = new Request(
        `https://example.com/api/drives/${mockDriveId}/history?limit=25&offset=10&operation=create&resourceType=page&actorId=actor_1`
      );
      const response = await GET(request, createContext(mockDriveId));

      expect(response.status).toBe(200);
      expect(getDriveVersionHistory).toHaveBeenCalledWith(
        mockDriveId,
        mockUserId,
        expect.objectContaining({
          limit: 25,
          offset: 10,
          operation: 'create',
          resourceType: 'page',
          actorId: 'actor_1',
        })
      );
    });

    it('should use default limit and offset when not provided', async () => {
      const request = new Request(`https://example.com/api/drives/${mockDriveId}/history`);
      await GET(request, createContext(mockDriveId));

      expect(getDriveVersionHistory).toHaveBeenCalledWith(
        mockDriveId,
        mockUserId,
        expect.objectContaining({
          limit: 50,
          offset: 0,
        })
      );
    });

    it('should return 400 for invalid query parameters', async () => {
      const request = new Request(
        `https://example.com/api/drives/${mockDriveId}/history?limit=-5`
      );
      const response = await GET(request, createContext(mockDriveId));

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(typeof body.error).toBe('string');
    });

    it('should return 400 for limit exceeding max (100)', async () => {
      const request = new Request(
        `https://example.com/api/drives/${mockDriveId}/history?limit=200`
      );
      const response = await GET(request, createContext(mockDriveId));

      expect(response.status).toBe(400);
    });

    it('should accept date parameters', async () => {
      const startDate = '2024-01-01T00:00:00.000Z';
      const endDate = '2024-12-31T23:59:59.000Z';

      const request = new Request(
        `https://example.com/api/drives/${mockDriveId}/history?startDate=${startDate}&endDate=${endDate}`
      );
      const response = await GET(request, createContext(mockDriveId));

      expect(response.status).toBe(200);
      expect(getDriveVersionHistory).toHaveBeenCalledWith(
        mockDriveId,
        mockUserId,
        expect.objectContaining({
          endDate: new Date(endDate),
        })
      );
    });
  });

  describe('retention limit logic', () => {
    it('should not modify startDate when retentionDays is unlimited (-1)', async () => {
      vi.mocked(getUserRetentionDays).mockResolvedValue(-1);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/history`);
      await GET(request, createContext(mockDriveId));

      expect(getDriveVersionHistory).toHaveBeenCalledWith(
        mockDriveId,
        mockUserId,
        expect.objectContaining({
          startDate: undefined,
        })
      );
    });

    it('should not modify startDate when retentionDays is 0', async () => {
      vi.mocked(getUserRetentionDays).mockResolvedValue(0);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/history`);
      await GET(request, createContext(mockDriveId));

      expect(getDriveVersionHistory).toHaveBeenCalledWith(
        mockDriveId,
        mockUserId,
        expect.objectContaining({
          startDate: undefined,
        })
      );
    });

    it('should apply retention cutoff when retentionDays > 0 and no startDate provided', async () => {
      vi.mocked(getUserRetentionDays).mockResolvedValue(30);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/history`);
      await GET(request, createContext(mockDriveId));

      const call = vi.mocked(getDriveVersionHistory).mock.calls[0];
      // @ts-expect-error - test assumes value exists
      const passedStartDate = call[2].startDate as Date;
      expect(passedStartDate).toBeInstanceOf(Date);
      // Should be approximately 30 days ago
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      expect(Math.abs(passedStartDate.getTime() - thirtyDaysAgo.getTime())).toBeLessThan(5000);
    });

    it('should apply retention cutoff when startDate is earlier than cutoff', async () => {
      vi.mocked(getUserRetentionDays).mockResolvedValue(30);

      // Set startDate to 90 days ago (earlier than the 30-day cutoff)
      const ninetyDaysAgo = new Date();
      ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

      const request = new Request(
        `https://example.com/api/drives/${mockDriveId}/history?startDate=${ninetyDaysAgo.toISOString()}`
      );
      await GET(request, createContext(mockDriveId));

      const call = vi.mocked(getDriveVersionHistory).mock.calls[0];
      // @ts-expect-error - test assumes value exists
      const passedStartDate = call[2].startDate as Date;
      // Should be retention cutoff (30 days ago), not the 90-day-ago value
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      expect(Math.abs(passedStartDate.getTime() - thirtyDaysAgo.getTime())).toBeLessThan(5000);
    });

    it('should keep user startDate when it is more recent than retention cutoff', async () => {
      vi.mocked(getUserRetentionDays).mockResolvedValue(30);

      // Set startDate to 5 days ago (more recent than the 30-day cutoff)
      const fiveDaysAgo = new Date();
      fiveDaysAgo.setDate(fiveDaysAgo.getDate() - 5);

      const request = new Request(
        `https://example.com/api/drives/${mockDriveId}/history?startDate=${fiveDaysAgo.toISOString()}`
      );
      await GET(request, createContext(mockDriveId));

      const call = vi.mocked(getDriveVersionHistory).mock.calls[0];
      // @ts-expect-error - test assumes value exists
      const passedStartDate = call[2].startDate as Date;
      // Should preserve the 5-day-ago start date since it's more recent than cutoff
      expect(Math.abs(passedStartDate.getTime() - fiveDaysAgo.getTime())).toBeLessThan(5000);
    });
  });

  describe('response contract', () => {
    it('should return versions with rollback eligibility', async () => {
      const activities = [
        { id: 'act_1', operation: 'create', resourceType: 'page' },
        { id: 'act_2', operation: 'update', resourceType: 'page' },
      ];
      vi.mocked(getDriveVersionHistory).mockResolvedValue({ activities, total: 2 } as never);
      vi.mocked(isActivityEligibleForRollback)
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(false);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/history`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.versions).toHaveLength(2);
      expect(body.versions[0].canRollback).toBe(true);
      expect(body.versions[1].canRollback).toBe(false);
    });

    it('should include pagination info', async () => {
      const activities = [
        { id: 'act_1', operation: 'create', resourceType: 'page' },
      ];
      vi.mocked(getDriveVersionHistory).mockResolvedValue({ activities, total: 100 } as never);

      const request = new Request(
        `https://example.com/api/drives/${mockDriveId}/history?limit=10&offset=5`
      );
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(body.pagination).toEqual({
        total: 100,
        limit: 10,
        offset: 5,
        hasMore: true,
      });
    });

    it('should set hasMore=false when at the end', async () => {
      const activities = [
        { id: 'act_1', operation: 'create', resourceType: 'page' },
      ];
      vi.mocked(getDriveVersionHistory).mockResolvedValue({ activities, total: 1 } as never);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/history`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(body.pagination.hasMore).toBe(false);
    });

    it('should include retentionDays in response', async () => {
      vi.mocked(getUserRetentionDays).mockResolvedValue(90);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/history`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(body.retentionDays).toBe(90);
    });

    it('should return empty versions array when no activities', async () => {
      vi.mocked(getDriveVersionHistory).mockResolvedValue({ activities: [], total: 0 });

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/history`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(body.versions).toEqual([]);
      expect(body.pagination.total).toBe(0);
      expect(body.pagination.hasMore).toBe(false);
    });
  });

  describe('logging', () => {
    it('should log debug messages for request and response', async () => {
      vi.mocked(getDriveVersionHistory).mockResolvedValue({ activities: [], total: 0 });

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/history`);
      await GET(request, createContext(mockDriveId));

      expect(loggers.api.debug).toHaveBeenCalledWith(
        '[History:Route] GET drive history request',
        expect.objectContaining({
          driveId: '***_abc',
          userId: '***_123',
        })
      );
      expect(loggers.api.debug).toHaveBeenCalledWith(
        '[History:Route] Returning drive history',
        expect.objectContaining({
          versionsCount: 0,
          total: 0,
        })
      );
    });

    it('should log permission denied at debug level', async () => {
      vi.mocked(isDriveOwnerOrAdmin).mockResolvedValue(false);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/history`);
      await GET(request, createContext(mockDriveId));

      expect(loggers.api.debug).toHaveBeenCalledWith(
        '[History:Route] Permission denied - not drive admin'
      );
    });
  });
});
