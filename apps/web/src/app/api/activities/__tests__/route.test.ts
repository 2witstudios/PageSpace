/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for GET /api/activities
//
// Tests the route handler's contract for fetching activity logs.
// Mocks at the DB query level and auth boundaries.
// ============================================================================

vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      activityLogs: { findMany: vi.fn() },
    },
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue([{ total: 0 }]),
      })),
    })),
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
  count: vi.fn(),
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

import { GET } from '../route';
import { db } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { isUserDriveMember, canUserViewPage } from '@pagespace/lib';
import { authenticateRequestWithOptions, isAuthError, checkMCPDriveScope, checkMCPPageScope, getAllowedDriveIds } from '@/lib/auth';

// ============================================================================
// Test Helpers
// ============================================================================

const mockWebAuth = (userId: string, role = 'user'): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session-id',
  adminRoleVersion: 0,
  role,
});

const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

// ============================================================================
// GET /api/activities - Contract Tests
// ============================================================================

describe('GET /api/activities', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(isUserDriveMember).mockResolvedValue(true);
    vi.mocked(canUserViewPage).mockResolvedValue(true);
    vi.mocked(getAllowedDriveIds).mockReturnValue([]);
    vi.mocked(checkMCPDriveScope).mockReturnValue(null);
    vi.mocked(checkMCPPageScope).mockReturnValue(null);

    // Default: empty activities
    vi.mocked(db.query.activityLogs.findMany).mockResolvedValue([]);
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

      const request = new Request('https://example.com/api/activities?context=user');
      const response = await GET(request);

      expect(response.status).toBe(401);
    });

    it('should call authenticateRequestWithOptions with correct auth options', async () => {
      const request = new Request('https://example.com/api/activities?context=user');
      await GET(request);

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['session', 'mcp'], requireCSRF: false }
      );
    });
  });

  describe('validation', () => {
    it('should return 400 for invalid context value', async () => {
      const request = new Request('https://example.com/api/activities?context=invalid');
      const response = await GET(request);

      expect(response.status).toBe(400);
    });

    it('should return 400 when driveId is missing for drive context', async () => {
      const request = new Request('https://example.com/api/activities?context=drive');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('driveId is required for drive context');
    });

    it('should return 400 when pageId is missing for page context', async () => {
      const request = new Request('https://example.com/api/activities?context=page');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('pageId is required for page context');
    });
  });

  describe('authorization', () => {
    it('should return 403 for inaccessible drive in drive context', async () => {
      vi.mocked(isUserDriveMember).mockResolvedValue(false);

      const request = new Request('https://example.com/api/activities?context=drive&driveId=drive_1');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Unauthorized - you do not have access to this drive');
    });

    it('should return 403 for inaccessible drive in user context with driveId filter', async () => {
      vi.mocked(isUserDriveMember).mockResolvedValue(false);

      const request = new Request('https://example.com/api/activities?context=user&driveId=drive_1');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Unauthorized - you do not have access to this drive');
    });

    it('should return 403 for inaccessible page in page context', async () => {
      vi.mocked(canUserViewPage).mockResolvedValue(false);

      const request = new Request('https://example.com/api/activities?context=page&pageId=page_1');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Unauthorized - you do not have access to this page');
    });

    it('should check MCP drive scope for drive context', async () => {
      vi.mocked(checkMCPDriveScope).mockReturnValue(
        NextResponse.json({ error: 'Scope denied' }, { status: 403 })
      );

      const request = new Request('https://example.com/api/activities?context=drive&driveId=drive_1');
      const response = await GET(request);

      expect(response.status).toBe(403);
    });
  });

  describe('success - user context', () => {
    it('should return activities with pagination', async () => {
      const mockActivities = [
        { id: 'act_1', operation: 'update', user: { id: 'user_123', name: 'Test', email: 'test@test.com', image: null } },
      ];
      vi.mocked(db.query.activityLogs.findMany).mockResolvedValue(mockActivities as any);
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ total: 1 }]),
        }),
      } as any);

      const request = new Request('https://example.com/api/activities?context=user');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.activities).toHaveLength(1);
      expect(body.pagination).toMatchObject({
        total: 1,
        limit: 50,
        offset: 0,
        hasMore: false,
      });
    });

    it('should respect limit and offset parameters', async () => {
      vi.mocked(db.query.activityLogs.findMany).mockResolvedValue([]);

      const request = new Request('https://example.com/api/activities?context=user&limit=10&offset=20');
      await GET(request);

      expect(db.query.activityLogs.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          limit: 10,
          offset: 20,
        })
      );
    });

    it('should filter by MCP allowed drive IDs when no driveId provided', async () => {
      vi.mocked(getAllowedDriveIds).mockReturnValue(['drive_a', 'drive_b']);

      const request = new Request('https://example.com/api/activities?context=user');
      await GET(request);

      expect(getAllowedDriveIds).toHaveBeenCalled();
    });
  });

  describe('success - drive context', () => {
    it('should return activities for a specific drive', async () => {
      vi.mocked(db.query.activityLogs.findMany).mockResolvedValue([]);
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ total: 0 }]),
        }),
      } as any);

      const request = new Request('https://example.com/api/activities?context=drive&driveId=drive_1');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.activities).toEqual([]);
      expect(isUserDriveMember).toHaveBeenCalledWith(mockUserId, 'drive_1');
    });
  });

  describe('success - page context', () => {
    it('should return activities for a specific page', async () => {
      vi.mocked(db.query.activityLogs.findMany).mockResolvedValue([]);
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ total: 0 }]),
        }),
      } as any);

      const request = new Request('https://example.com/api/activities?context=page&pageId=page_1');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.activities).toEqual([]);
      expect(canUserViewPage).toHaveBeenCalledWith(mockUserId, 'page_1');
    });
  });

  describe('filters', () => {
    it('should apply startDate filter', async () => {
      const request = new Request('https://example.com/api/activities?context=user&startDate=2024-01-01');
      const response = await GET(request);

      expect(response.status).toBe(200);
    });

    it('should apply endDate filter', async () => {
      const request = new Request('https://example.com/api/activities?context=user&endDate=2024-12-31');
      const response = await GET(request);

      expect(response.status).toBe(200);
    });

    it('should apply actorId filter in drive context only', async () => {
      const request = new Request('https://example.com/api/activities?context=drive&driveId=drive_1&actorId=actor_1');
      const response = await GET(request);

      expect(response.status).toBe(200);
    });

    it('should apply operation filter', async () => {
      const request = new Request('https://example.com/api/activities?context=user&operation=update');
      const response = await GET(request);

      expect(response.status).toBe(200);
    });

    it('should apply resourceType filter', async () => {
      const request = new Request('https://example.com/api/activities?context=user&resourceType=page');
      const response = await GET(request);

      expect(response.status).toBe(200);
    });
  });

  describe('error handling', () => {
    it('should return 500 when database query fails', async () => {
      vi.mocked(db.query.activityLogs.findMany).mockRejectedValue(new Error('DB error'));

      const request = new Request('https://example.com/api/activities?context=user');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch activities');
    });

    it('should log error when query fails', async () => {
      const error = new Error('Query failed');
      vi.mocked(db.query.activityLogs.findMany).mockRejectedValue(error);

      const request = new Request('https://example.com/api/activities?context=user');
      await GET(request);

      expect(loggers.api.error).toHaveBeenCalledWith('Error fetching activities:', error);
    });
  });
});
