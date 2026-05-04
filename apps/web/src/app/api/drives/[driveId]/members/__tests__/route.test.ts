import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';
import type { DriveAccessResult, MemberWithDetails } from '@pagespace/lib/services/drive-member-service';

// ============================================================================
// Contract Tests for /api/drives/[driveId]/members
//
// POST mocks the driveInviteRepository seam (rubric §4) — no ORM chain mocks.
// GET still mocks the read services (checkDriveAccess, listDriveMembers); the
// GET handler is out of scope for the Epic 2 refactor, so its existing seams
// are preserved.
// ============================================================================

vi.mock('@/lib/repositories/drive-invite-repository', () => ({
  driveInviteRepository: {
    findDriveById: vi.fn(),
    findAdminMembership: vi.fn(),
    findExistingMember: vi.fn(),
    createDriveMember: vi.fn(),
    updateDriveMemberRole: vi.fn(),
    getValidPageIds: vi.fn(),
    findPagePermission: vi.fn(),
    createPagePermission: vi.fn(),
    updatePagePermission: vi.fn(),
    findUserEmail: vi.fn(),
  },
}));

vi.mock('@pagespace/lib/services/drive-member-service', () => ({
  checkDriveAccess: vi.fn(),
  listDriveMembers: vi.fn(),
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({
  audit: vi.fn(),
  auditRequest: vi.fn(),
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
}));

vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  getActorInfo: vi.fn().mockResolvedValue({ userId: 'user_123', email: 'user@example.com' }),
  logMemberActivity: vi.fn(),
}));

import { GET, POST } from '../route';
import { driveInviteRepository } from '@/lib/repositories/drive-invite-repository';
import { checkDriveAccess, listDriveMembers } from '@pagespace/lib/services/drive-member-service';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { getActorInfo, logMemberActivity } from '@pagespace/lib/monitoring/activity-logger';

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

const createInsertedMember = (overrides: {
  id?: string;
  driveId: string;
  userId: string;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  invitedBy: string;
}) => ({
  id: overrides.id ?? 'mem_new',
  driveId: overrides.driveId,
  userId: overrides.userId,
  role: overrides.role,
  customRoleId: null,
  invitedBy: overrides.invitedBy,
  invitedAt: new Date('2024-01-01'),
  acceptedAt: new Date('2024-01-01'),
  lastAccessedAt: null,
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
        { allow: ['session'], requireCSRF: false }
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

// ============================================================================
// POST /api/drives/[driveId]/members - Contract Tests (seam-mocked)
// ============================================================================

describe('POST /api/drives/[driveId]/members', () => {
  const mockUserId = 'user_123';
  const mockDriveId = 'drive_abc';
  const mockInvitedUserId = 'user_456';

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(getActorInfo).mockResolvedValue({
      actorEmail: 'user@example.com',
      actorDisplayName: 'User 123',
    });
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members`, {
        method: 'POST',
        body: JSON.stringify({ userId: mockInvitedUserId }),
      });
      const response = await POST(request, createContext(mockDriveId));

      expect(response.status).toBe(401);
    });

    it('should require CSRF for write operations', async () => {
      vi.mocked(driveInviteRepository.findDriveById).mockResolvedValue(
        createDriveFixture({ id: mockDriveId, name: 'Test', ownerId: mockUserId })
      );
      vi.mocked(driveInviteRepository.findExistingMember).mockResolvedValue(null);
      vi.mocked(driveInviteRepository.createDriveMember).mockResolvedValue(
        createInsertedMember({
          driveId: mockDriveId,
          userId: mockInvitedUserId,
          role: 'MEMBER',
          invitedBy: mockUserId,
        })
      );

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members`, {
        method: 'POST',
        body: JSON.stringify({ userId: mockInvitedUserId }),
      });
      await POST(request, createContext(mockDriveId));

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['session'], requireCSRF: true }
      );
    });
  });

  describe('authorization', () => {
    it('should return 404 when drive not found', async () => {
      vi.mocked(driveInviteRepository.findDriveById).mockResolvedValue(null);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members`, {
        method: 'POST',
        body: JSON.stringify({ userId: mockInvitedUserId }),
      });
      const response = await POST(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Drive not found');
    });

    it('should return 403 when caller is not the drive owner', async () => {
      vi.mocked(driveInviteRepository.findDriveById).mockResolvedValue(
        createDriveFixture({ id: mockDriveId, name: 'Test', ownerId: 'other_user' })
      );

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members`, {
        method: 'POST',
        body: JSON.stringify({ userId: mockInvitedUserId }),
      });
      const response = await POST(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Only drive owner can add members');
      expect(driveInviteRepository.findExistingMember).not.toHaveBeenCalled();
      expect(driveInviteRepository.createDriveMember).not.toHaveBeenCalled();
    });
  });

  describe('validation', () => {
    it('should reject when target is already a drive member', async () => {
      vi.mocked(driveInviteRepository.findDriveById).mockResolvedValue(
        createDriveFixture({ id: mockDriveId, name: 'Test', ownerId: mockUserId })
      );
      vi.mocked(driveInviteRepository.findExistingMember).mockResolvedValue({
        id: 'mem_existing',
        driveId: mockDriveId,
        userId: mockInvitedUserId,
        role: 'MEMBER',
        customRoleId: null,
        invitedBy: mockUserId,
        invitedAt: new Date(),
        acceptedAt: new Date(),
        lastAccessedAt: null,
      });

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members`, {
        method: 'POST',
        body: JSON.stringify({ userId: mockInvitedUserId }),
      });
      const response = await POST(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('User is already a member');
      expect(driveInviteRepository.createDriveMember).not.toHaveBeenCalled();
    });
  });

  describe('seam integration', () => {
    it('should look up drive via driveInviteRepository.findDriveById', async () => {
      vi.mocked(driveInviteRepository.findDriveById).mockResolvedValue(
        createDriveFixture({ id: mockDriveId, name: 'Test', ownerId: mockUserId })
      );
      vi.mocked(driveInviteRepository.findExistingMember).mockResolvedValue(null);
      vi.mocked(driveInviteRepository.createDriveMember).mockResolvedValue(
        createInsertedMember({
          driveId: mockDriveId,
          userId: mockInvitedUserId,
          role: 'MEMBER',
          invitedBy: mockUserId,
        })
      );

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members`, {
        method: 'POST',
        body: JSON.stringify({ userId: mockInvitedUserId }),
      });
      await POST(request, createContext(mockDriveId));

      expect(driveInviteRepository.findDriveById).toHaveBeenCalledWith(mockDriveId);
    });

    it('should look up existing member via findExistingMember', async () => {
      vi.mocked(driveInviteRepository.findDriveById).mockResolvedValue(
        createDriveFixture({ id: mockDriveId, name: 'Test', ownerId: mockUserId })
      );
      vi.mocked(driveInviteRepository.findExistingMember).mockResolvedValue(null);
      vi.mocked(driveInviteRepository.createDriveMember).mockResolvedValue(
        createInsertedMember({
          driveId: mockDriveId,
          userId: mockInvitedUserId,
          role: 'MEMBER',
          invitedBy: mockUserId,
        })
      );

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members`, {
        method: 'POST',
        body: JSON.stringify({ userId: mockInvitedUserId }),
      });
      await POST(request, createContext(mockDriveId));

      expect(driveInviteRepository.findExistingMember).toHaveBeenCalledWith(
        mockDriveId,
        mockInvitedUserId
      );
    });

    it('should call createDriveMember with auto-accepted MEMBER row', async () => {
      vi.mocked(driveInviteRepository.findDriveById).mockResolvedValue(
        createDriveFixture({ id: mockDriveId, name: 'Test', ownerId: mockUserId })
      );
      vi.mocked(driveInviteRepository.findExistingMember).mockResolvedValue(null);
      vi.mocked(driveInviteRepository.createDriveMember).mockResolvedValue(
        createInsertedMember({
          driveId: mockDriveId,
          userId: mockInvitedUserId,
          role: 'MEMBER',
          invitedBy: mockUserId,
        })
      );

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members`, {
        method: 'POST',
        body: JSON.stringify({ userId: mockInvitedUserId }),
      });
      await POST(request, createContext(mockDriveId));

      expect(driveInviteRepository.createDriveMember).toHaveBeenCalledWith(
        expect.objectContaining({
          driveId: mockDriveId,
          userId: mockInvitedUserId,
          role: 'MEMBER',
          customRoleId: null,
          invitedBy: mockUserId,
          acceptedAt: expect.any(Date),
        })
      );
    });

    it('should call createDriveMember with ADMIN role when requested', async () => {
      vi.mocked(driveInviteRepository.findDriveById).mockResolvedValue(
        createDriveFixture({ id: mockDriveId, name: 'Test', ownerId: mockUserId })
      );
      vi.mocked(driveInviteRepository.findExistingMember).mockResolvedValue(null);
      vi.mocked(driveInviteRepository.createDriveMember).mockResolvedValue(
        createInsertedMember({
          driveId: mockDriveId,
          userId: mockInvitedUserId,
          role: 'ADMIN',
          invitedBy: mockUserId,
        })
      );

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members`, {
        method: 'POST',
        body: JSON.stringify({ userId: mockInvitedUserId, role: 'ADMIN' }),
      });
      await POST(request, createContext(mockDriveId));

      expect(driveInviteRepository.createDriveMember).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'ADMIN' })
      );
    });
  });

  describe('side effects', () => {
    it('should record member_add activity log entry with drive name and target', async () => {
      vi.mocked(driveInviteRepository.findDriveById).mockResolvedValue(
        createDriveFixture({ id: mockDriveId, name: 'Test Drive', ownerId: mockUserId })
      );
      vi.mocked(driveInviteRepository.findExistingMember).mockResolvedValue(null);
      vi.mocked(driveInviteRepository.createDriveMember).mockResolvedValue(
        createInsertedMember({
          driveId: mockDriveId,
          userId: mockInvitedUserId,
          role: 'MEMBER',
          invitedBy: mockUserId,
        })
      );

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members`, {
        method: 'POST',
        body: JSON.stringify({ userId: mockInvitedUserId }),
      });
      await POST(request, createContext(mockDriveId));

      expect(logMemberActivity).toHaveBeenCalledWith(
        mockUserId,
        'member_add',
        expect.objectContaining({
          driveId: mockDriveId,
          driveName: 'Test Drive',
          targetUserId: mockInvitedUserId,
          role: 'MEMBER',
        }),
        expect.any(Object)
      );
    });

    it('should emit authz.permission.granted audit event', async () => {
      vi.mocked(driveInviteRepository.findDriveById).mockResolvedValue(
        createDriveFixture({ id: mockDriveId, name: 'Test', ownerId: mockUserId })
      );
      vi.mocked(driveInviteRepository.findExistingMember).mockResolvedValue(null);
      vi.mocked(driveInviteRepository.createDriveMember).mockResolvedValue(
        createInsertedMember({
          driveId: mockDriveId,
          userId: mockInvitedUserId,
          role: 'MEMBER',
          invitedBy: mockUserId,
        })
      );

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members`, {
        method: 'POST',
        body: JSON.stringify({ userId: mockInvitedUserId }),
      });
      await POST(request, createContext(mockDriveId));

      expect(auditRequest).toHaveBeenCalledWith(
        request,
        expect.objectContaining({
          eventType: 'authz.permission.granted',
          userId: mockUserId,
          resourceType: 'drive',
          resourceId: mockDriveId,
          details: expect.objectContaining({
            targetUserId: mockInvitedUserId,
            role: 'MEMBER',
          }),
        })
      );
    });
  });

  describe('response contract', () => {
    it('should return 200 with the created member envelope', async () => {
      const inserted = createInsertedMember({
        id: 'mem_new',
        driveId: mockDriveId,
        userId: mockInvitedUserId,
        role: 'MEMBER',
        invitedBy: mockUserId,
      });

      vi.mocked(driveInviteRepository.findDriveById).mockResolvedValue(
        createDriveFixture({ id: mockDriveId, name: 'Test', ownerId: mockUserId })
      );
      vi.mocked(driveInviteRepository.findExistingMember).mockResolvedValue(null);
      vi.mocked(driveInviteRepository.createDriveMember).mockResolvedValue(inserted);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members`, {
        method: 'POST',
        body: JSON.stringify({ userId: mockInvitedUserId }),
      });
      const response = await POST(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.member).toMatchObject({
        id: 'mem_new',
        userId: mockInvitedUserId,
        role: 'MEMBER',
        invitedBy: mockUserId,
      });
    });

    it('should default to MEMBER role when no role specified', async () => {
      vi.mocked(driveInviteRepository.findDriveById).mockResolvedValue(
        createDriveFixture({ id: mockDriveId, name: 'Test', ownerId: mockUserId })
      );
      vi.mocked(driveInviteRepository.findExistingMember).mockResolvedValue(null);
      vi.mocked(driveInviteRepository.createDriveMember).mockResolvedValue(
        createInsertedMember({
          driveId: mockDriveId,
          userId: mockInvitedUserId,
          role: 'MEMBER',
          invitedBy: mockUserId,
        })
      );

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members`, {
        method: 'POST',
        body: JSON.stringify({ userId: mockInvitedUserId }),
      });
      await POST(request, createContext(mockDriveId));

      expect(driveInviteRepository.createDriveMember).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'MEMBER' })
      );
    });

    it('should echo ADMIN role in response when requested', async () => {
      vi.mocked(driveInviteRepository.findDriveById).mockResolvedValue(
        createDriveFixture({ id: mockDriveId, name: 'Test', ownerId: mockUserId })
      );
      vi.mocked(driveInviteRepository.findExistingMember).mockResolvedValue(null);
      vi.mocked(driveInviteRepository.createDriveMember).mockResolvedValue(
        createInsertedMember({
          driveId: mockDriveId,
          userId: mockInvitedUserId,
          role: 'ADMIN',
          invitedBy: mockUserId,
        })
      );

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members`, {
        method: 'POST',
        body: JSON.stringify({ userId: mockInvitedUserId, role: 'ADMIN' }),
      });
      const response = await POST(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.member.role).toBe('ADMIN');
    });
  });

  describe('error handling', () => {
    it('should return 500 when the seam throws', async () => {
      vi.mocked(driveInviteRepository.findDriveById).mockResolvedValue(
        createDriveFixture({ id: mockDriveId, name: 'Test', ownerId: mockUserId })
      );
      vi.mocked(driveInviteRepository.findExistingMember).mockResolvedValue(null);
      vi.mocked(driveInviteRepository.createDriveMember).mockRejectedValueOnce(
        new Error('Insert failed')
      );

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members`, {
        method: 'POST',
        body: JSON.stringify({ userId: mockInvitedUserId }),
      });
      const response = await POST(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to add member');
    });

    it('should log the error when the seam throws', async () => {
      const error = new Error('Repository failure');
      vi.mocked(driveInviteRepository.findDriveById).mockResolvedValue(
        createDriveFixture({ id: mockDriveId, name: 'Test', ownerId: mockUserId })
      );
      vi.mocked(driveInviteRepository.findExistingMember).mockResolvedValue(null);
      vi.mocked(driveInviteRepository.createDriveMember).mockRejectedValueOnce(error);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members`, {
        method: 'POST',
        body: JSON.stringify({ userId: mockInvitedUserId }),
      });
      await POST(request, createContext(mockDriveId));

      expect(loggers.api.error).toHaveBeenCalledWith('Error adding drive member:', error);
    });
  });
});
