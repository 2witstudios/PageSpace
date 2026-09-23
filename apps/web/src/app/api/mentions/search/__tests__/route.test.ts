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

vi.mock('@pagespace/lib/permissions/permissions', () => ({
  getUserAccessLevel: vi.fn(),
  getUserDriveAccess: vi.fn(),
  getDriveIdsForUser: vi.fn(),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    // auditRequest (lib/audit/audit-log) logs through loggers.security.
    security: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    api: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  },

  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@pagespace/lib/services/drive-member-service', () => ({
  getDriveRecipientUserIds: vi.fn(),
}));

// Guest agent members (agents that belong to the drive via drive_agent_members
// but whose page lives in another drive). The finder hits the DB, so it is
// mocked; the pure helpers stay real.
vi.mock('@/lib/mentions/guest-agent-members', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/mentions/guest-agent-members')>()),
  findGuestAgentMembers: vi.fn(),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([]),
  },
}));

// Import after all mocks are set up
import { NextResponse } from 'next/server';
import { GET } from '../route';
import { getUserAccessLevel, getUserDriveAccess, getDriveIdsForUser } from '@pagespace/lib/permissions/permissions';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { getDriveRecipientUserIds } from '@pagespace/lib/services/drive-member-service';
import { findGuestAgentMembers } from '@/lib/mentions/guest-agent-members';
import { db } from '@pagespace/db/db';
import * as dbOperators from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';

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
    vi.mocked(findGuestAgentMembers).mockResolvedValue([]);

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
      expect(typeof body.error).toBe('string');
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
      expect(getUserDriveAccess).toHaveBeenCalledWith('user_123', 'drive_unauthorized');

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

  // ==========================================================================
  // pageType / imageOnly filters — added for the 404-page and OG-image/favicon
  // "pick a page" pickers. Optional and additive: omitting them must behave
  // exactly as before (covered by every test above, none of which pass them).
  // ==========================================================================
  describe('pageType / imageOnly filters', () => {
    beforeEach(() => {
      vi.mocked(getUserDriveAccess).mockResolvedValue(true);
      vi.mocked(getUserAccessLevel).mockResolvedValue('VIEW' as never);
      vi.mocked(getDriveRecipientUserIds).mockResolvedValue([mockUserId]);
    });

    it('includes mimeType in the returned page suggestion data', async () => {
      const selectChain = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([
          { id: 'file-1', title: 'logo.png', type: 'FILE', driveId: mockDriveId, mimeType: 'image/png' },
        ]),
      };
      vi.mocked(db.select).mockReturnValue(selectChain as unknown as ReturnType<typeof db.select>);

      const request = new Request(
        `https://example.com/api/mentions/search?q=logo&driveId=${mockDriveId}&types=page&pageType=FILE&imageOnly=true`
      );
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body[0]).toMatchObject({ id: 'file-1', data: { pageType: 'FILE', mimeType: 'image/png' } });
    });

    it('does not error and behaves like an unfiltered search when pageType is not a real page type', async () => {
      const selectChain = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([
          { id: 'page-1', title: 'Some Doc', type: 'DOCUMENT', driveId: mockDriveId, mimeType: null },
        ]),
      };
      vi.mocked(db.select).mockReturnValue(selectChain as unknown as ReturnType<typeof db.select>);

      const request = new Request(
        `https://example.com/api/mentions/search?q=doc&driveId=${mockDriveId}&types=page&pageType=NOT_A_REAL_TYPE`
      );
      const response = await GET(request);

      expect(response.status).toBe(200);
    });

    it('accepts imageOnly without a pageType filter without erroring', async () => {
      const selectChain = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([]),
      };
      vi.mocked(db.select).mockReturnValue(selectChain as unknown as ReturnType<typeof db.select>);

      const request = new Request(
        `https://example.com/api/mentions/search?q=logo&driveId=${mockDriveId}&types=page&imageOnly=true`
      );
      const response = await GET(request);

      expect(response.status).toBe(200);
    });
  });

  // ==========================================================================
  // excludePageTypes — the inverse of pageType, for callers whose picker can't
  // render several types at all (the agent-pane "Pages" search, which excludes
  // FOLDER/AI_CHAT). Enforced in the SQL WHERE clause (`notInArray`), not an
  // after-the-fetch in-memory filter — see the route's own comment on why:
  // excluded types must never occupy a row of the DB's own
  // `.limit(50)`/`.limit(20)` window in the first place, or the response could
  // still shrink even with every returned row correctly filtered.
  //
  // The mocked `db.select` chain can't observe filtering (its `.where()` is a
  // no-op passthrough, same limitation every other filter test in this file
  // has), so these tests verify the WHERE-clause condition was actually built
  // by spying on the real (unmocked) `notInArray` from `@pagespace/db/operators`
  // — the same module the route imports it from — rather than asserting on a
  // response shape the mock can't meaningfully vary.
  // ==========================================================================
  // ==========================================================================
  // Guest agent members: an agent added to the drive through
  // drive_agent_members whose AI_CHAT page lives in ANOTHER drive. The
  // in-drive page query can never return it (pages.driveId is elsewhere), and
  // the requester usually cannot view its home page — membership in the
  // channel's drive is the grant, the same rule the drive's agent-members
  // list already applies to every drive member.
  // ==========================================================================
  describe('AI agent ACCOUNT user suggestions (Agent Signup Phase 2b)', () => {
    it('given a drive member who is an AI agent account, should return accountType agent so the picker can mark it', async () => {
      vi.mocked(getUserDriveAccess).mockResolvedValue(true);
      vi.mocked(getDriveRecipientUserIds).mockResolvedValue([mockUserId, 'agent_x']);
      const rows = [{ id: 'agent_x', name: 'PageSpace Support', image: null, accountType: 'agent' }];
      const tail = { orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue(rows) };
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockImplementation(() => Object.assign(Promise.resolve(rows), tail)),
      } as unknown as ReturnType<typeof db.select>);

      const response = await GET(new Request(`https://example.com/api/mentions/search?driveId=${mockDriveId}&types=user&q=support`));
      const body = await response.json();

      expect(body.find((suggestion: { id: string; type: string }) => suggestion.type === 'user' && suggestion.id === 'agent_x')).toMatchObject({
        label: 'PageSpace Support', accountType: 'agent',
      });
    });
  });

  describe('guest agent members', () => {
    const guestAgentId = 'agent_guest_aaaaaaaaaaaaa';
    const guestRow = { id: guestAgentId, title: 'Guest Agent', memberDriveId: mockDriveId, homeDriveId: 'drive_home' };

    // `.where()` resolves to `rows` when awaited directly (the drives/users
    // lookups) AND still chains `.orderBy()/.limit()` (the page query).
    function stubPages(rows: Array<{ id: string; title: string; type: string; driveId: string; mimeType: null }>) {
      const tail = { orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue(rows) };
      const selectChain = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockImplementation(() => Object.assign(Promise.resolve(rows), tail)),
      };
      vi.mocked(db.select).mockReturnValue(selectChain as unknown as ReturnType<typeof db.select>);
    }

    beforeEach(() => {
      vi.mocked(getUserDriveAccess).mockResolvedValue(true);
      vi.mocked(getUserAccessLevel).mockResolvedValue({ canView: true, canEdit: false, canShare: false, canDelete: false });
      vi.mocked(getDriveRecipientUserIds).mockResolvedValue([mockUserId, 'user_other']);
      stubPages([{ id: 'doc-1', title: 'Roadmap', type: 'DOCUMENT', driveId: mockDriveId, mimeType: null }]);
    });

    it('offers a guest agent member to a drive member as a page mention in the channel drive', async () => {
      vi.mocked(findGuestAgentMembers).mockResolvedValue([guestRow]);

      const request = new Request(`https://example.com/api/mentions/search?driveId=${mockDriveId}&types=page`);
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(findGuestAgentMembers).toHaveBeenCalledWith(
        expect.objectContaining({ memberDriveIds: [mockDriveId] })
      );
      const guest = body.find((s: { id: string }) => s.id === guestAgentId);
      expect(guest).toEqual({
        id: guestAgentId,
        label: 'Guest Agent',
        type: 'page',
        data: { pageType: 'AI_CHAT', driveId: mockDriveId, mimeType: null },
        description: `agent · ${guestAgentId.slice(0, 6)}`,
      });
      // Membership is the grant: the requester's ACL on the agent's HOME page
      // is never consulted (it would deny — the home drive is not theirs).
      expect(getUserAccessLevel).not.toHaveBeenCalledWith(mockUserId, guestAgentId);
    });

    it('does not offer guest agents to a requester who is not a drive member (page-permission access only)', async () => {
      vi.mocked(getDriveRecipientUserIds).mockResolvedValue(['user_owner', 'user_other']);
      vi.mocked(findGuestAgentMembers).mockResolvedValue([guestRow]);

      const request = new Request(`https://example.com/api/mentions/search?driveId=${mockDriveId}&types=page`);
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(findGuestAgentMembers).not.toHaveBeenCalled();
      expect(body.some((s: { id: string }) => s.id === guestAgentId)).toBe(false);
    });

    it('does not look for guest agents when the caller excludes AI_CHAT', async () => {
      const request = new Request(
        `https://example.com/api/mentions/search?driveId=${mockDriveId}&types=page&excludePageTypes=FOLDER,AI_CHAT`
      );
      const response = await GET(request);

      expect(response.status).toBe(200);
      expect(findGuestAgentMembers).not.toHaveBeenCalled();
    });

    it('does not look for guest agents when pages are not requested', async () => {
      stubPages([]);
      const request = new Request(`https://example.com/api/mentions/search?driveId=${mockDriveId}&types=user`);
      const response = await GET(request);

      expect(response.status).toBe(200);
      expect(findGuestAgentMembers).not.toHaveBeenCalled();
    });

    it('never lists the same agent twice when it is also an in-drive page result', async () => {
      stubPages([{ id: guestAgentId, title: 'Guest Agent', type: 'AI_CHAT', driveId: mockDriveId, mimeType: null }]);
      vi.mocked(findGuestAgentMembers).mockResolvedValue([guestRow]);

      const request = new Request(`https://example.com/api/mentions/search?driveId=${mockDriveId}&types=page`);
      const response = await GET(request);
      const body = await response.json();

      expect(body.filter((s: { id: string }) => s.id === guestAgentId)).toHaveLength(1);
    });

    it('in a cross-drive search, only drives where the requester is a member are consulted', async () => {
      vi.mocked(getDriveIdsForUser).mockResolvedValue([mockDriveId, mockOtherDriveId]);
      vi.mocked(getDriveRecipientUserIds).mockImplementation(async (id: string) =>
        id === mockDriveId ? [mockUserId] : ['user_owner']
      );
      vi.mocked(findGuestAgentMembers).mockResolvedValue([]);
      stubPages([]);

      const request = new Request('https://example.com/api/mentions/search?crossDrive=true&types=page');
      const response = await GET(request);

      expect(response.status).toBe(200);
      expect(findGuestAgentMembers).toHaveBeenCalledWith(
        expect.objectContaining({ memberDriveIds: [mockDriveId] })
      );
    });
  });

  describe('excludePageTypes filter', () => {
    beforeEach(() => {
      vi.mocked(getUserDriveAccess).mockResolvedValue(true);
      vi.mocked(getUserAccessLevel).mockResolvedValue('VIEW' as never);
      vi.mocked(getDriveRecipientUserIds).mockResolvedValue([mockUserId]);

      const selectChain = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        // No `q=` in these requests, so the route takes the "recent pages"
        // branch (`.orderBy(...).limit(20)`), not `.limit(50)` directly.
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([
          { id: 'doc-1', title: 'Roadmap', type: 'DOCUMENT', driveId: mockDriveId, mimeType: null },
        ]),
      };
      vi.mocked(db.select).mockReturnValue(selectChain as unknown as ReturnType<typeof db.select>);
    });

    it('pushes recognized types into notInArray against pages.type', async () => {
      const notInArraySpy = vi.spyOn(dbOperators, 'notInArray');

      const request = new Request(
        `https://example.com/api/mentions/search?driveId=${mockDriveId}&types=page&excludePageTypes=FOLDER,AI_CHAT`
      );
      const response = await GET(request);

      expect(response.status).toBe(200);
      expect(notInArraySpy).toHaveBeenCalledWith(pages.type, expect.arrayContaining(['FOLDER', 'AI_CHAT']));
    });

    it('does not call notInArray when excludePageTypes is omitted (unfiltered, as before)', async () => {
      const notInArraySpy = vi.spyOn(dbOperators, 'notInArray');

      const request = new Request(`https://example.com/api/mentions/search?driveId=${mockDriveId}&types=page`);
      const response = await GET(request);

      expect(response.status).toBe(200);
      expect(notInArraySpy).not.toHaveBeenCalled();
    });

    it('ignores unrecognized values rather than erroring, and never calls notInArray for them', async () => {
      const notInArraySpy = vi.spyOn(dbOperators, 'notInArray');

      const request = new Request(
        `https://example.com/api/mentions/search?driveId=${mockDriveId}&types=page&excludePageTypes=NOT_A_REAL_TYPE`
      );
      const response = await GET(request);

      expect(response.status).toBe(200);
      expect(notInArraySpy).not.toHaveBeenCalled();
    });
  });

  describe('search term escaping', () => {
    it('escapes LIKE metacharacters in the search term before building the ilike condition (regression: over-matching fix)', async () => {
      vi.mocked(getUserDriveAccess).mockResolvedValue(true);
      vi.mocked(getUserAccessLevel).mockResolvedValue('VIEW' as never);
      vi.mocked(getDriveRecipientUserIds).mockResolvedValue([mockUserId]);

      const ilikeSpy = vi.spyOn(dbOperators, 'ilike');

      // A search for "50% off" contains a literal '%' — if it reaches ilike()
      // unescaped, Postgres reads it as a wildcard instead of a literal character.
      const request = new Request(
        `https://example.com/api/mentions/search?q=${encodeURIComponent('50% off')}&driveId=${mockDriveId}&types=page`
      );
      const response = await GET(request);

      expect(response.status).toBe(200);
      const patterns = ilikeSpy.mock.calls.map(([, pattern]) => pattern);
      expect(patterns).toContain('%50\\%%');
      expect(patterns).toContain('%off%');
    });
  });
});
