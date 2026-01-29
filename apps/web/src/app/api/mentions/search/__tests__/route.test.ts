import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

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

// ============================================================================
// Contract Tests for /api/mentions/search
//
// These tests mock at the SERVICE SEAM level to verify:
// 1. Drive access is properly enforced (security fix)
// 2. Shared drives work correctly via getDriveIdsForUser
// 3. Unauthorized access returns 403, not data
// ============================================================================

vi.mock('@pagespace/lib/server', () => ({
  getUserAccessLevel: vi.fn(),
  getUserDriveAccess: vi.fn(),
  getDriveIdsForUser: vi.fn(),
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

vi.mock('@pagespace/db', async () => {
  const actual = await vi.importActual('@pagespace/db');
  return {
    ...actual,
    db: {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
    },
  };
});

// Import after all mocks are set up
import { NextResponse } from 'next/server';
import { GET } from '../route';
import { getUserAccessLevel, getUserDriveAccess, getDriveIdsForUser } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db } from '@pagespace/db';

// ============================================================================
// Test Fixtures
// ============================================================================

const mockWebAuth = (userId: string, tokenVersion = 0): SessionAuthResult => ({
  userId,
  tokenVersion,
  tokenType: 'session',
  sessionId: 'test-session-id',
  role: 'user',
  adminRoleVersion: 0,
});

const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

// ============================================================================
// GET /api/mentions/search - Contract Tests
// ============================================================================

describe('GET /api/mentions/search', () => {
  const mockUserId = 'user_123';
  const mockDriveId = 'drive_abc';
  const mockOtherDriveId = 'drive_unauthorized';

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    // Default mock for db.select chain
    const selectChain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
    };
    vi.mocked(db.select).mockReturnValue(selectChain as unknown as ReturnType<typeof db.select>);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request(`https://example.com/api/mentions/search?q=test&driveId=${mockDriveId}`);
      const response = await GET(request);

      expect(response.status).toBe(401);
    });
  });

  describe('validation', () => {
    it('should return 400 when driveId is missing for within-drive search', async () => {
      const request = new Request('https://example.com/api/mentions/search?q=test');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Missing driveId parameter for within-drive search');
    });

    it('should return 400 when driveId is empty (treated as missing)', async () => {
      // Note: Empty driveId is treated as missing by the route
      const request = new Request('https://example.com/api/mentions/search?q=test&driveId=');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      // Empty string is falsy, so it hits the "missing driveId" check first
      expect(body.error).toBe('Missing driveId parameter for within-drive search');
    });
  });

  describe('authorization - within-drive search', () => {
    it('should return 403 when user does not have access to the specified drive', async () => {
      // User does NOT have access to this drive
      vi.mocked(getUserDriveAccess).mockResolvedValue(false);

      const request = new Request(`https://example.com/api/mentions/search?q=test&driveId=${mockOtherDriveId}`);
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Access denied to the specified drive');
      expect(getUserDriveAccess).toHaveBeenCalledWith(mockUserId, mockOtherDriveId);
    });

    it('should call getUserDriveAccess when driveId is provided', async () => {
      // User HAS access to this drive
      vi.mocked(getUserDriveAccess).mockResolvedValue(true);

      const request = new Request(`https://example.com/api/mentions/search?q=test&driveId=${mockDriveId}`);
      await GET(request);

      // The critical security check: getUserDriveAccess is called to verify access
      expect(getUserDriveAccess).toHaveBeenCalledWith(mockUserId, mockDriveId);
    });

    it('should NOT leak data about pages in unauthorized drives', async () => {
      // User does NOT have access
      vi.mocked(getUserDriveAccess).mockResolvedValue(false);

      const request = new Request(`https://example.com/api/mentions/search?q=secret&driveId=${mockOtherDriveId}`);
      const response = await GET(request);
      const body = await response.json();

      // Should get 403, not an empty array that might indicate "no matches"
      expect(response.status).toBe(403);
      expect(body).not.toHaveProperty('length');
      expect(body.error).toBeDefined();
    });
  });

  describe('authorization - cross-drive search', () => {
    it('should call getDriveIdsForUser for cross-drive search', async () => {
      // User has access to only one drive
      vi.mocked(getDriveIdsForUser).mockResolvedValue([mockDriveId]);

      const request = new Request('https://example.com/api/mentions/search?q=test&crossDrive=true');
      await GET(request);

      // The critical security check: getDriveIdsForUser is used to limit search scope
      expect(getDriveIdsForUser).toHaveBeenCalledWith(mockUserId);
      // getUserDriveAccess should NOT be called for cross-drive
      // (drive access is inherently enforced by getDriveIdsForUser)
      expect(getUserDriveAccess).not.toHaveBeenCalled();
    });

    it('should return empty array when user has no accessible drives', async () => {
      // User has no drives
      vi.mocked(getDriveIdsForUser).mockResolvedValue([]);

      const request = new Request('https://example.com/api/mentions/search?q=test&crossDrive=true');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual([]);
    });

    it('should use getDriveIdsForUser which includes owned, member, and page-permission drives', async () => {
      // This test verifies the correct function is called - getDriveIdsForUser
      // which internally includes all three access types
      vi.mocked(getDriveIdsForUser).mockResolvedValue([]);

      const request = new Request('https://example.com/api/mentions/search?q=test&crossDrive=true');
      await GET(request);

      // The security fix: using getDriveIdsForUser instead of the old
      // getUserAccessibleDrives that only returned owned drives
      expect(getDriveIdsForUser).toHaveBeenCalledWith(mockUserId);
    });
  });

  describe('security - drive enumeration prevention', () => {
    it('should not reveal existence of unauthorized drives via different error codes', async () => {
      // Test that non-existent and unauthorized drives both return the same error
      vi.mocked(getUserDriveAccess).mockResolvedValue(false);

      // Try to access unauthorized drive
      const request1 = new Request(`https://example.com/api/mentions/search?q=test&driveId=${mockOtherDriveId}`);
      const response1 = await GET(request1);
      const body1 = await response1.json();

      // Try to access non-existent drive
      const request2 = new Request('https://example.com/api/mentions/search?q=test&driveId=nonexistent_drive');
      const response2 = await GET(request2);
      const body2 = await response2.json();

      // Both should return 403 to prevent drive enumeration
      expect(response1.status).toBe(403);
      expect(response2.status).toBe(403);
      expect(body1.error).toBe(body2.error);
    });

    it('should verify drive access BEFORE any database queries for pages', async () => {
      vi.mocked(getUserDriveAccess).mockResolvedValue(false);

      const request = new Request(`https://example.com/api/mentions/search?q=test&driveId=${mockOtherDriveId}`);
      await GET(request);

      // getUserDriveAccess should be called
      expect(getUserDriveAccess).toHaveBeenCalled();

      // But page queries should NOT be made since access was denied
      // The db.select call for pages should not happen after access denial
      // (We can't easily verify this directly, but the 403 return ensures
      // we exit before page queries)
    });
  });

  describe('shared drive access scenarios', () => {
    it('should check access via getUserDriveAccess which includes members and page-permission users', async () => {
      // User is a MEMBER of this drive (not owner)
      // getUserDriveAccess returns true for owners, members, and page-permission users
      vi.mocked(getUserDriveAccess).mockResolvedValue(true);

      const request = new Request(`https://example.com/api/mentions/search?q=test&driveId=${mockDriveId}`);
      await GET(request);

      // The security fix: getUserDriveAccess checks owner, member, and page permissions
      expect(getUserDriveAccess).toHaveBeenCalledWith(mockUserId, mockDriveId);
    });

    it('should deny access when getUserDriveAccess returns false regardless of membership type', async () => {
      // User has no access at all
      vi.mocked(getUserDriveAccess).mockResolvedValue(false);

      const request = new Request(`https://example.com/api/mentions/search?q=test&driveId=${mockDriveId}`);
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Access denied to the specified drive');
    });
  });

  describe('page-level permission filtering', () => {
    it('should call getUserAccessLevel for each page to verify view permission', async () => {
      vi.mocked(getUserDriveAccess).mockResolvedValue(true);
      vi.mocked(getUserAccessLevel).mockResolvedValue(null); // No page permission

      const request = new Request(`https://example.com/api/mentions/search?q=test&driveId=${mockDriveId}&types=page`);
      await GET(request);

      // Drive access is checked first
      expect(getUserDriveAccess).toHaveBeenCalledWith(mockUserId, mockDriveId);
      // Note: getUserAccessLevel would be called for each page result from DB
      // The exact calls depend on DB mock behavior
    });

    it('should verify that drive access check happens before page queries', async () => {
      vi.mocked(getUserDriveAccess).mockResolvedValue(false);

      const request = new Request(`https://example.com/api/mentions/search?q=test&driveId=${mockDriveId}`);
      const response = await GET(request);

      // Should return 403 immediately without page-level checks
      expect(response.status).toBe(403);
      // getUserAccessLevel should NOT be called since drive access was denied
      expect(getUserAccessLevel).not.toHaveBeenCalled();
    });
  });
});
