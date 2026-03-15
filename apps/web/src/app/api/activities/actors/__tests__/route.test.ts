/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for GET /api/activities/actors
//
// Tests the route handler's contract for fetching unique activity actors.
// ============================================================================

vi.mock('@pagespace/db', () => ({
  db: {
    selectDistinct: vi.fn(() => ({
      from: vi.fn(() => ({
        leftJoin: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn().mockResolvedValue([]),
          })),
        })),
      })),
    })),
  },
  activityLogs: {
    userId: 'userId',
    driveId: 'driveId',
    isArchived: 'isArchived',
    actorDisplayName: 'actorDisplayName',
    actorEmail: 'actorEmail',
  },
  users: {
    id: 'id',
    name: 'name',
    email: 'email',
    image: 'image',
  },
  eq: vi.fn(),
  and: vi.fn((...args: unknown[]) => args),
  sql: Object.assign(vi.fn(() => ({ as: vi.fn(() => 'mocked_sql') })), { join: vi.fn() }),
  inArray: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('@pagespace/lib', () => ({
  isUserDriveMember: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
  checkMCPDriveScope: vi.fn(() => null),
  getAllowedDriveIds: vi.fn(() => []),
}));

import { GET } from '../route';
import { db } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { isUserDriveMember } from '@pagespace/lib';
import { authenticateRequestWithOptions, isAuthError, checkMCPDriveScope, getAllowedDriveIds } from '@/lib/auth';

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

describe('GET /api/activities/actors', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(isUserDriveMember).mockResolvedValue(true);
    vi.mocked(checkMCPDriveScope).mockReturnValue(null);
    vi.mocked(getAllowedDriveIds).mockReturnValue([]);

    vi.mocked(db.selectDistinct).mockReturnValue({
      from: vi.fn().mockReturnValue({
        leftJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
    } as any);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/activities/actors?context=drive&driveId=d1');
      const response = await GET(request);

      expect(response.status).toBe(401);
    });
  });

  describe('validation', () => {
    it('should return 400 for invalid context value', async () => {
      const request = new Request('https://example.com/api/activities/actors?context=invalid');
      const response = await GET(request);

      expect(response.status).toBe(400);
    });

    it('should return 400 when driveId is missing for drive context', async () => {
      const request = new Request('https://example.com/api/activities/actors?context=drive');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('driveId is required for drive context');
    });
  });

  describe('authorization', () => {
    it('should return 403 for inaccessible drive', async () => {
      vi.mocked(isUserDriveMember).mockResolvedValue(false);

      const request = new Request('https://example.com/api/activities/actors?context=drive&driveId=d1');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Unauthorized - you do not have access to this drive');
    });

    it('should check MCP drive scope', async () => {
      vi.mocked(checkMCPDriveScope).mockReturnValue(
        NextResponse.json({ error: 'Scope denied' }, { status: 403 })
      );

      const request = new Request('https://example.com/api/activities/actors?context=drive&driveId=d1');
      const response = await GET(request);

      expect(response.status).toBe(403);
    });
  });

  describe('success - drive context', () => {
    it('should return actors for a drive', async () => {
      const mockActors = [
        { id: 'user_1', name: 'Alice', email: 'alice@test.com', image: null, sortKey: 'Alice' },
      ];
      vi.mocked(db.selectDistinct).mockReturnValue({
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockResolvedValue(mockActors),
            }),
          }),
        }),
      } as any);

      const request = new Request('https://example.com/api/activities/actors?context=drive&driveId=d1');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.actors).toEqual(mockActors);
    });
  });

  describe('success - user context', () => {
    it('should return actors for user context', async () => {
      const request = new Request('https://example.com/api/activities/actors?context=user');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.actors).toEqual([]);
    });
  });

  describe('error handling', () => {
    it('should return 500 when database query fails', async () => {
      vi.mocked(db.selectDistinct).mockImplementation(() => {
        throw new Error('DB error');
      });

      const request = new Request('https://example.com/api/activities/actors?context=user');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch activity actors');
    });

    it('should log error when query fails', async () => {
      const error = new Error('Query failed');
      vi.mocked(db.selectDistinct).mockImplementation(() => {
        throw error;
      });

      const request = new Request('https://example.com/api/activities/actors?context=user');
      await GET(request);

      expect(loggers.api.error).toHaveBeenCalledWith('Error fetching activity actors:', error);
    });
  });
});
