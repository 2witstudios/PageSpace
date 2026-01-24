import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { GET, POST } from '../route';
import type { SessionAuthResult, AuthError } from '@/lib/auth';
import type { DriveAccessResult, MemberWithDetails } from '@pagespace/lib/server';

// ============================================================================
// Contract Tests for /api/drives/[driveId]/members
//
// These tests mock at the SERVICE SEAM level (checkDriveAccess, listDriveMembers,
// isMemberOfDrive, addDriveMember), NOT at the ORM/query-builder level.
// ============================================================================

// Mock at the service seam - this is the ONLY place we mock DB-related logic
vi.mock('@pagespace/lib/server', () => ({
  checkDriveAccess: vi.fn(),
  listDriveMembers: vi.fn(),
  isMemberOfDrive: vi.fn(),
  addDriveMember: vi.fn(),
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

import {
  checkDriveAccess,
  listDriveMembers,
  isMemberOfDrive,
  addDriveMember,
  loggers,
} from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

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

      // Verify member structure
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
      vi.mocked(checkDriveAccess).mockRejectedValue(new Error('Database connection lost'));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch members');
    });

    it('should log error when service throws', async () => {
      const error = new Error('Service failure');
      vi.mocked(checkDriveAccess).mockRejectedValue(error);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members`);
      await GET(request, createContext(mockDriveId));

      expect(loggers.api.error).toHaveBeenCalledWith('Error fetching drive members:', error);
    });
  });
});

// ============================================================================
// POST /api/drives/[driveId]/members - Contract Tests
// ============================================================================

describe('POST /api/drives/[driveId]/members', () => {
  const mockUserId = 'user_123';
  const mockDriveId = 'drive_abc';
  const mockInvitedUserId = 'user_456';

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
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
      vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
      }));
      vi.mocked(isMemberOfDrive).mockResolvedValue(false);
      vi.mocked(addDriveMember).mockResolvedValue({
        id: 'mem_new',
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
      await POST(request, createContext(mockDriveId));

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['session'], requireCSRF: true }
      );
    });
  });

  describe('authorization', () => {
    it('should return 404 when drive not found', async () => {
      vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({ drive: null }));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members`, {
        method: 'POST',
        body: JSON.stringify({ userId: mockInvitedUserId }),
      });
      const response = await POST(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Drive not found');
    });

    it('should return 403 when user is not drive owner', async () => {
      vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
        isOwner: false,
        isAdmin: true, // Admin cannot add members
        isMember: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test', ownerId: 'other_user' }),
      }));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members`, {
        method: 'POST',
        body: JSON.stringify({ userId: mockInvitedUserId }),
      });
      const response = await POST(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Only drive owner can add members');
    });
  });

  describe('validation', () => {
    it('should reject when user is already a member', async () => {
      vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test', ownerId: mockUserId }),
      }));
      vi.mocked(isMemberOfDrive).mockResolvedValue(true);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members`, {
        method: 'POST',
        body: JSON.stringify({ userId: mockInvitedUserId }),
      });
      const response = await POST(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('User is already a member');
    });
  });

  describe('service integration', () => {
    it('should call checkDriveAccess with driveId and userId', async () => {
      vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
      }));
      vi.mocked(isMemberOfDrive).mockResolvedValue(false);
      vi.mocked(addDriveMember).mockResolvedValue({
        id: 'mem_new',
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
      await POST(request, createContext(mockDriveId));

      expect(checkDriveAccess).toHaveBeenCalledWith(mockDriveId, mockUserId);
    });

    it('should call isMemberOfDrive with driveId and invitedUserId', async () => {
      vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
      }));
      vi.mocked(isMemberOfDrive).mockResolvedValue(false);
      vi.mocked(addDriveMember).mockResolvedValue({
        id: 'mem_new',
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
      await POST(request, createContext(mockDriveId));

      expect(isMemberOfDrive).toHaveBeenCalledWith(mockDriveId, mockInvitedUserId);
    });

    it('should call addDriveMember with correct parameters', async () => {
      vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
      }));
      vi.mocked(isMemberOfDrive).mockResolvedValue(false);
      vi.mocked(addDriveMember).mockResolvedValue({
        id: 'mem_new',
        driveId: mockDriveId,
        userId: mockInvitedUserId,
        role: 'ADMIN',
        customRoleId: null,
        invitedBy: mockUserId,
        invitedAt: new Date(),
        acceptedAt: new Date(),
        lastAccessedAt: null,
      });

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members`, {
        method: 'POST',
        body: JSON.stringify({ userId: mockInvitedUserId, role: 'ADMIN' }),
      });
      await POST(request, createContext(mockDriveId));

      expect(addDriveMember).toHaveBeenCalledWith(mockDriveId, mockUserId, {
        userId: mockInvitedUserId,
        role: 'ADMIN',
      });
    });
  });

  describe('response contract', () => {
    it('should return 200 with member on successful creation', async () => {
      const newMember = {
        id: 'mem_new',
        driveId: mockDriveId,
        userId: mockInvitedUserId,
        role: 'MEMBER' as const,
        customRoleId: null,
        invitedBy: mockUserId,
        invitedAt: new Date(),
        acceptedAt: new Date(),
        lastAccessedAt: null,
      };

      vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
      }));
      vi.mocked(isMemberOfDrive).mockResolvedValue(false);
      vi.mocked(addDriveMember).mockResolvedValue(newMember);

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

    it('should add member with default MEMBER role', async () => {
      vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
      }));
      vi.mocked(isMemberOfDrive).mockResolvedValue(false);
      vi.mocked(addDriveMember).mockResolvedValue({
        id: 'mem_new',
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
      await POST(request, createContext(mockDriveId));

      expect(addDriveMember).toHaveBeenCalledWith(mockDriveId, mockUserId, {
        userId: mockInvitedUserId,
        role: 'MEMBER',
      });
    });

    it('should add member with specified ADMIN role', async () => {
      vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
      }));
      vi.mocked(isMemberOfDrive).mockResolvedValue(false);
      vi.mocked(addDriveMember).mockResolvedValue({
        id: 'mem_new',
        driveId: mockDriveId,
        userId: mockInvitedUserId,
        role: 'ADMIN',
        customRoleId: null,
        invitedBy: mockUserId,
        invitedAt: new Date(),
        acceptedAt: new Date(),
        lastAccessedAt: null,
      });

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
    it('should return 500 when service throws', async () => {
      vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
      }));
      vi.mocked(isMemberOfDrive).mockResolvedValue(false);
      vi.mocked(addDriveMember).mockRejectedValue(new Error('Insert failed'));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members`, {
        method: 'POST',
        body: JSON.stringify({ userId: mockInvitedUserId }),
      });
      const response = await POST(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to add member');
    });

    it('should log error when service throws', async () => {
      const error = new Error('Service failure');
      vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
      }));
      vi.mocked(isMemberOfDrive).mockResolvedValue(false);
      vi.mocked(addDriveMember).mockRejectedValue(error);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members`, {
        method: 'POST',
        body: JSON.stringify({ userId: mockInvitedUserId }),
      });
      await POST(request, createContext(mockDriveId));

      expect(loggers.api.error).toHaveBeenCalledWith('Error adding drive member:', error);
    });
  });
});
