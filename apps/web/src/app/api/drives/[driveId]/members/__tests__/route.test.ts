import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';
import type { DriveAccessResult, MemberWithDetails } from '@pagespace/lib/services/drive-member-service';

// ============================================================================
// Contract Tests for GET /api/drives/[driveId]/members
//
// The legacy POST handler was retired in Epic 4 — POST is now served by
// /api/drives/[driveId]/members/invite which accepts both userId and email
// payloads.
// ============================================================================

vi.mock('@pagespace/lib/services/drive-member-service', () => ({
  checkDriveAccess: vi.fn(),
  listDriveMembers: vi.fn(),
  getDriveOwnerAsMember: vi.fn(),
}));

vi.mock('@/lib/repositories/drive-invite-repository', () => ({
  driveInviteRepository: {
    findUnconsumedInvitesByDrive: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
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
  checkMCPDriveScope: vi.fn(),
  isPrincipalDriveOwnerOrAdmin: vi.fn(),
}));

import { GET } from '../route';
import { checkDriveAccess, listDriveMembers, getDriveOwnerAsMember } from '@pagespace/lib/services/drive-member-service';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { authenticateRequestWithOptions, isAuthError, checkMCPDriveScope, isPrincipalDriveOwnerOrAdmin } from '@/lib/auth';
import { driveInviteRepository } from '@/lib/repositories/drive-invite-repository';

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

const createDriveFixture = (overrides: {
  id: string;
  name: string;
  ownerId?: string;
}) => ({
  id: overrides.id,
  name: overrides.name,
  slug: overrides.name.toLowerCase().replace(/\s+/g, '-'),
  ownerId: overrides.ownerId ?? 'user_123',
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
  isTrashed: false,
  trashedAt: null,
  drivePrompt: null,
  kind: 'STANDARD' as const,
  publishSubdomain: null,
  homePageId: null,
  publishDefaultOgImageUrl: null,
});

const createAccessFixture = (overrides: Partial<DriveAccessResult>): DriveAccessResult => ({
  isOwner: overrides.isOwner ?? false,
  isAdmin: overrides.isAdmin ?? false,
  isMember: overrides.isMember ?? false,
  drive: overrides.drive ?? null,
});

const createMemberFixture = (overrides: {
  id: string;
  userId: string;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  email?: string;
}): MemberWithDetails => ({
  id: overrides.id,
  userId: overrides.userId,
  role: overrides.role,
  invitedBy: null,
  invitedAt: new Date('2024-01-01'),
  acceptedAt: new Date('2024-01-01'),
  lastAccessedAt: null,
  user: {
    id: overrides.userId,
    email: overrides.email ?? `${overrides.userId}@example.com`,
    name: `User ${overrides.userId}`,
  },
  profile: {
    username: overrides.userId,
    displayName: `User ${overrides.userId}`,
    avatarUrl: null,
  },
  customRole: null,
  permissionCounts: {
    view: 0,
    edit: 0,
    share: 0,
  },
});

const createOwnerMemberFixture = (userId: string): MemberWithDetails => ({
  id: `owner-${userId}`,
  userId,
  role: 'OWNER',
  invitedBy: null,
  invitedAt: null,
  acceptedAt: null,
  lastAccessedAt: null,
  user: {
    id: userId,
    email: `${userId}@example.com`,
    name: `User ${userId}`,
  },
  profile: {
    username: userId,
    displayName: `User ${userId}`,
    avatarUrl: null,
  },
  customRole: null,
  permissionCounts: { view: 0, edit: 0, share: 0 },
});

const createContext = (driveId: string) => ({
  params: Promise.resolve({ driveId }),
});

// ============================================================================
// GET /api/drives/[driveId]/members - Contract Tests
// ============================================================================

describe('GET /api/drives/[driveId]/members', () => {
  const mockUserId = 'user_123';
  const mockDriveId = 'drive_abc';

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(checkMCPDriveScope).mockReturnValue(null);
    vi.mocked(driveInviteRepository.findUnconsumedInvitesByDrive).mockResolvedValue([]);
    vi.mocked(getDriveOwnerAsMember).mockResolvedValue(null);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members`);
      const response = await GET(request, createContext(mockDriveId));

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBe('Unauthorized');
    });

    it('should call authenticateRequestWithOptions with correct auth options', async () => {
      vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
        isOwner: true,
        isMember: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
      }));
      vi.mocked(listDriveMembers).mockResolvedValue([]);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members`);
      await GET(request, createContext(mockDriveId));

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['session', 'mcp'], requireCSRF: false }
      );
    });
  });

  describe('authorization', () => {
    it('should return 404 when drive not found', async () => {
      vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({ drive: null }));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Drive not found');
    });

    it('should return 403 when user is not a member', async () => {
      vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
        isOwner: false,
        isMember: false,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test', ownerId: 'other_user' }),
      }));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('You must be a drive member to view members');
    });
  });

  describe('service integration', () => {
    it('should call checkDriveAccess with driveId and userId', async () => {
      vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
        isOwner: true,
        isMember: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
      }));
      vi.mocked(listDriveMembers).mockResolvedValue([]);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members`);
      await GET(request, createContext(mockDriveId));

      expect(checkDriveAccess).toHaveBeenCalledWith(mockDriveId, mockUserId);
    });

    it('should call listDriveMembers with driveId', async () => {
      vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
        isOwner: true,
        isMember: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
      }));
      vi.mocked(listDriveMembers).mockResolvedValue([]);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members`);
      await GET(request, createContext(mockDriveId));

      expect(listDriveMembers).toHaveBeenCalledWith(mockDriveId);
    });
  });

  describe('response contract', () => {
    it('should return currentUserRole=OWNER for drive owner', async () => {
      vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
        isOwner: true,
        isAdmin: true,
        isMember: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test', ownerId: mockUserId }),
      }));
      vi.mocked(listDriveMembers).mockResolvedValue([]);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.currentUserRole).toBe('OWNER');
    });

    it('should return currentUserRole=ADMIN for admin member', async () => {
      vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
        isOwner: false,
        isAdmin: true,
        isMember: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test', ownerId: 'other_user' }),
      }));
      vi.mocked(listDriveMembers).mockResolvedValue([]);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.currentUserRole).toBe('ADMIN');
    });

    it('should return currentUserRole=MEMBER for regular member', async () => {
      vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
        isOwner: false,
        isAdmin: false,
        isMember: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test', ownerId: 'other_user' }),
      }));
      vi.mocked(listDriveMembers).mockResolvedValue([]);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.currentUserRole).toBe('MEMBER');
    });

    it('should return members array with user details and permission counts', async () => {
      const members = [
        createMemberFixture({ id: 'mem_1', userId: 'user_456', role: 'ADMIN', email: 'admin@example.com' }),
        createMemberFixture({ id: 'mem_2', userId: 'user_789', role: 'MEMBER', email: 'member@example.com' }),
      ];
      members[0].permissionCounts = { view: 5, edit: 3, share: 1 };

      vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
        isOwner: true,
        isMember: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
      }));
      vi.mocked(listDriveMembers).mockResolvedValue(members);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.members).toHaveLength(2);

      expect(body.members[0]).toMatchObject({
        id: 'mem_1',
        userId: 'user_456',
        role: 'ADMIN',
        user: { email: 'admin@example.com' },
        permissionCounts: { view: 5, edit: 3, share: 1 },
      });

      expect(body.members[1]).toMatchObject({
        id: 'mem_2',
        userId: 'user_789',
        role: 'MEMBER',
      });
    });

    it('should return empty members array when drive has no members', async () => {
      vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
        isOwner: true,
        isMember: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
      }));
      vi.mocked(listDriveMembers).mockResolvedValue([]);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.members).toEqual([]);
    });
  });

  // ==========================================================================
  // Owner inclusion + unaccepted-invitee exclusion — regression coverage for
  // #1771: the owner has no drive_members row, and pending invites must not
  // be indistinguishable from accepted members.
  // ==========================================================================
  describe('owner inclusion and unaccepted-invitee exclusion', () => {
    it('prepends the OWNER, who has no drive_members row, ahead of regular members', async () => {
      const owner = createOwnerMemberFixture('owner_1');
      const admin = createMemberFixture({ id: 'mem_1', userId: 'user_456', role: 'ADMIN' });

      vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
        isOwner: false,
        isAdmin: true,
        isMember: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test', ownerId: 'owner_1' }),
      }));
      vi.mocked(listDriveMembers).mockResolvedValue([admin]);
      vi.mocked(getDriveOwnerAsMember).mockResolvedValue(owner);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.members).toHaveLength(2);
      expect(body.members[0]).toMatchObject({ userId: 'owner_1', role: 'OWNER' });
      expect(body.members[1]).toMatchObject({ userId: 'user_456', role: 'ADMIN' });
    });

    it('excludes drive_members rows without acceptedAt (pending invites are not members)', async () => {
      const owner = createOwnerMemberFixture('owner_1');
      const accepted = createMemberFixture({ id: 'mem_1', userId: 'user_456', role: 'MEMBER' });
      const unaccepted = { ...createMemberFixture({ id: 'mem_2', userId: 'user_789', role: 'MEMBER' }), acceptedAt: null };

      vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
        isOwner: true,
        isMember: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test', ownerId: 'owner_1' }),
      }));
      vi.mocked(listDriveMembers).mockResolvedValue([accepted, unaccepted]);
      vi.mocked(getDriveOwnerAsMember).mockResolvedValue(owner);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(200);
      const userIds = body.members.map((m: { userId: string }) => m.userId);
      expect(userIds).toEqual(['owner_1', 'user_456']);
      expect(userIds).not.toContain('user_789');
    });

    it('does not double-count the owner if they also have an accepted drive_members row', async () => {
      const owner = createOwnerMemberFixture('owner_1');
      const ownerAsMemberRow = createMemberFixture({ id: 'mem_owner', userId: 'owner_1', role: 'OWNER' });
      const regular = createMemberFixture({ id: 'mem_1', userId: 'user_456', role: 'MEMBER' });

      vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
        isOwner: true,
        isMember: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test', ownerId: 'owner_1' }),
      }));
      vi.mocked(listDriveMembers).mockResolvedValue([ownerAsMemberRow, regular]);
      vi.mocked(getDriveOwnerAsMember).mockResolvedValue(owner);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(200);
      const ownerEntries = body.members.filter((m: { userId: string }) => m.userId === 'owner_1');
      expect(ownerEntries).toHaveLength(1);
    });
  });

  describe('pendingInvites field', () => {
    const samplePending = [{
      id: 'inv_1',
      email: 'invitee@example.com',
      role: 'MEMBER' as const,
      customRoleId: null,
      customRoleName: null,
      customRoleColor: null,
      driveId: 'drive_abc',
      invitedByName: 'Alice',
      createdAt: new Date('2024-02-01'),
      expiresAt: new Date('2024-02-03') as Date | null,
    }];

    it('returns populated pendingInvites for OWNER', async () => {
      vi.mocked(isPrincipalDriveOwnerOrAdmin).mockResolvedValue(true);
      vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
        isOwner: true, isMember: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test', ownerId: mockUserId }),
      }));
      vi.mocked(listDriveMembers).mockResolvedValue([]);
      vi.mocked(driveInviteRepository.findUnconsumedInvitesByDrive).mockResolvedValue(samplePending);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(driveInviteRepository.findUnconsumedInvitesByDrive).toHaveBeenCalledWith(mockDriveId);
      expect(body.pendingInvites).toHaveLength(1);
      expect(body.pendingInvites[0]).toMatchObject({
        id: 'inv_1',
        email: 'invitee@example.com',
        role: 'MEMBER',
        invitedByName: 'Alice',
      });
    });

    it('returns populated pendingInvites for ADMIN', async () => {
      vi.mocked(isPrincipalDriveOwnerOrAdmin).mockResolvedValue(true);
      vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
        isOwner: false, isAdmin: true, isMember: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
      }));
      vi.mocked(listDriveMembers).mockResolvedValue([]);
      vi.mocked(driveInviteRepository.findUnconsumedInvitesByDrive).mockResolvedValue(samplePending);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(body.pendingInvites).toHaveLength(1);
    });

    it('returns empty pendingInvites for regular MEMBER (no leak)', async () => {
      vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
        isOwner: false, isAdmin: false, isMember: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
      }));
      vi.mocked(listDriveMembers).mockResolvedValue([]);
      vi.mocked(driveInviteRepository.findUnconsumedInvitesByDrive).mockResolvedValue(samplePending);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      // Field present (stable shape across roles) but empty for MEMBER
      expect(body.pendingInvites).toEqual([]);
      // Repo should not even be queried for non-OWNER/ADMIN
      expect(driveInviteRepository.findUnconsumedInvitesByDrive).not.toHaveBeenCalled();
    });

    it('field is always an array (never undefined) when authorized', async () => {
      vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
        isOwner: false, isAdmin: false, isMember: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
      }));
      vi.mocked(listDriveMembers).mockResolvedValue([]);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(Array.isArray(body.pendingInvites)).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should return 500 when service throws', async () => {
      vi.mocked(checkDriveAccess).mockRejectedValueOnce(new Error('Database connection lost'));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch members');
    });

    it('should log error when service throws', async () => {
      const error = new Error('Service failure');
      vi.mocked(checkDriveAccess).mockRejectedValueOnce(error);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members`);
      await GET(request, createContext(mockDriveId));

      expect(loggers.api.error).toHaveBeenCalledWith('Error fetching drive members:', error);
    });
  });
});
