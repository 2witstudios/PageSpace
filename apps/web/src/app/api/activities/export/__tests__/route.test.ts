/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for GET /api/activities/export
//
// Tests the route handler's contract for exporting activity logs as CSV.
// ============================================================================

vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      activityLogs: { findMany: vi.fn() },
    },
  },
  activityLogs: {
    userId: 'userId',
    driveId: 'driveId',
    pageId: 'pageId',
    isArchived: 'isArchived',
    timestamp: 'timestamp',
    operation: 'operation',
    resourceType: 'resourceType',
  },
  eq: vi.fn(),
  and: vi.fn((...args: unknown[]) => args),
  desc: vi.fn(),
  gte: vi.fn(),
  lt: vi.fn(),
  inArray: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('@pagespace/lib', () => ({
  generateCSV: vi.fn((data: string[][]) => data.map(row => row.join(',')).join('\n')),
  canUserViewPage: vi.fn(),
  isUserDriveMember: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
  checkMCPDriveScope: vi.fn(() => null),
  checkMCPPageScope: vi.fn(() => null),
  getAllowedDriveIds: vi.fn(() => []),
}));

vi.mock('date-fns', () => ({
  format: vi.fn((date: Date, fmt: string) => {
    if (fmt === 'yyyy-MM-dd HH:mm:ss') return '2024-01-01 00:00:00';
    if (fmt === 'yyyy-MM-dd') return '2024-01-01';
    return date.toISOString();
  }),
}));

import { GET } from '../route';
import { db } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { isUserDriveMember, canUserViewPage, generateCSV } from '@pagespace/lib';
import { authenticateRequestWithOptions, isAuthError, checkMCPDriveScope, checkMCPPageScope, getAllowedDriveIds } from '@/lib/auth';
import { format } from 'date-fns';

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
// Tests
// ============================================================================

describe('GET /api/activities/export', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(isUserDriveMember).mockResolvedValue(true);
    vi.mocked(canUserViewPage).mockResolvedValue(true);
    vi.mocked(checkMCPDriveScope).mockReturnValue(null);
    vi.mocked(checkMCPPageScope).mockReturnValue(null);
    vi.mocked(getAllowedDriveIds).mockReturnValue([]);
    vi.mocked(generateCSV).mockImplementation((data: string[][]) => data.map(row => row.join(',')).join('\n'));
    vi.mocked(format).mockImplementation((_date: unknown, fmt: string) => {
      if (fmt === 'yyyy-MM-dd HH:mm:ss') return '2024-01-01 00:00:00';
      if (fmt === 'yyyy-MM-dd') return '2024-01-01';
      return '2024-01-01';
    });
    vi.mocked(db.query.activityLogs.findMany).mockResolvedValue([]);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/activities/export?context=user');
      const response = await GET(request);

      expect(response.status).toBe(401);
    });
  });

  describe('validation', () => {
    it('should return 400 when driveId missing for drive context', async () => {
      const request = new Request('https://example.com/api/activities/export?context=drive');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('driveId is required for drive context');
    });

    it('should return 400 when pageId missing for page context', async () => {
      const request = new Request('https://example.com/api/activities/export?context=page');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('pageId is required for page context');
    });
  });

  describe('authorization', () => {
    it('should return 403 for inaccessible drive in drive context', async () => {
      vi.mocked(isUserDriveMember).mockResolvedValue(false);

      const request = new Request('https://example.com/api/activities/export?context=drive&driveId=d1');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Unauthorized - you do not have access to this drive');
    });

    it('should return 403 for inaccessible page in page context', async () => {
      vi.mocked(canUserViewPage).mockResolvedValue(false);

      const request = new Request('https://example.com/api/activities/export?context=page&pageId=p1');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Unauthorized - you do not have access to this page');
    });
  });

  describe('success - CSV export', () => {
    it('should return CSV response with correct headers', async () => {
      const request = new Request('https://example.com/api/activities/export?context=user');
      const response = await GET(request);

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('text/csv; charset=utf-8');
      expect(response.headers.get('Content-Disposition')).toContain('attachment; filename=');
      expect(response.headers.get('Content-Disposition')).toContain('.csv');
    });

    it('should call generateCSV with activity data', async () => {
      vi.mocked(db.query.activityLogs.findMany).mockResolvedValue([
        {
          id: 'act_1',
          timestamp: new Date('2024-01-01'),
          operation: 'update',
          resourceType: 'page',
          resourceTitle: 'Test Page',
          actorDisplayName: 'Test User',
          actorEmail: 'test@test.com',
          isAiGenerated: false,
          aiProvider: null,
          aiModel: null,
          updatedFields: ['title'],
          user: { id: 'u1', name: 'Test User', email: 'test@test.com' },
        },
      ] as any);

      const request = new Request('https://example.com/api/activities/export?context=user');
      const response = await GET(request);

      expect(response.status).toBe(200);
      expect(generateCSV).toHaveBeenCalled();
    });

    it('should use safety limit of 10000', async () => {
      const request = new Request('https://example.com/api/activities/export?context=user');
      await GET(request);

      expect(db.query.activityLogs.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 10000 })
      );
    });

    it('should include date range in filename when both dates provided', async () => {
      const request = new Request(
        'https://example.com/api/activities/export?context=user&startDate=2024-01-01&endDate=2024-12-31'
      );
      const response = await GET(request);

      const disposition = response.headers.get('Content-Disposition') || '';
      expect(disposition).toContain('activity-export');
    });

    it('should set X-Truncated header when results are truncated', async () => {
      // Create 10000 mock entries to simulate truncation
      const mockActivities = Array.from({ length: 10000 }, (_, i) => ({
        id: `act_${i}`,
        timestamp: new Date('2024-01-01'),
        operation: 'update',
        resourceType: 'page',
        resourceTitle: 'Test',
        actorDisplayName: 'User',
        actorEmail: 'user@test.com',
        isAiGenerated: false,
        aiProvider: null,
        aiModel: null,
        updatedFields: null,
        user: { id: 'u1', name: 'User', email: 'user@test.com' },
      }));
      vi.mocked(db.query.activityLogs.findMany).mockResolvedValue(mockActivities as any);

      const request = new Request('https://example.com/api/activities/export?context=user');
      const response = await GET(request);

      expect(response.headers.get('X-Truncated')).toBe('true');
      expect(response.headers.get('X-Truncated-At')).toBe('10000');
    });
  });

  describe('error handling', () => {
    it('should return 500 when database query fails', async () => {
      vi.mocked(db.query.activityLogs.findMany).mockRejectedValue(new Error('DB error'));

      const request = new Request('https://example.com/api/activities/export?context=user');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to export activities');
    });

    it('should log error when query fails', async () => {
      const error = new Error('Export failed');
      vi.mocked(db.query.activityLogs.findMany).mockRejectedValue(error);

      const request = new Request('https://example.com/api/activities/export?context=user');
      await GET(request);

      expect(loggers.api.error).toHaveBeenCalledWith('Error exporting activities:', error);
    });
  });
});
