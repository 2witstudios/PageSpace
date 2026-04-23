import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { GET, PATCH, DELETE } from '../route';
import type { SessionAuthResult, AuthError } from '@/lib/auth';
// Use inferred types to avoid export issues
type DriveAccessResult = Awaited<ReturnType<typeof import('@pagespace/lib/server').checkDriveAccess>>;
type MemberDetails = NonNullable<Awaited<ReturnType<typeof import('@pagespace/lib/server').getDriveMemberDetails>>>;
type MemberPermission = Awaited<ReturnType<typeof import('@pagespace/lib/server').getMemberPermissions>>[number];

// ============================================================================
// Contract Tests for /api/drives/[driveId]/members/[userId]
//
// These tests mock at the SERVICE SEAM level (checkDriveAccess, getDriveMemberDetails,
// getMemberPermissions, updateMemberRole, updateMemberPermissions), NOT at ORM level.
// ============================================================================

// Mock at the service seam - this is the ONLY place we mock DB-related logic
vi.mock('@pagespace/lib/server', () => ({
  checkDriveAccess: vi.fn(),
  getDriveMemberDetails: vi.fn(),
  getMemberPermissions: vi.fn(),
  updateMemberRole: vi.fn(),
  updateMemberPermissions: vi.fn(),
  audit: vi.fn(),
  auditRequest: vi.fn(),
  loggers: {
    api: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  },
}));

vi.mock('@pagespace/lib', () => ({
  createDriveNotification: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/websocket', () => ({
  broadcastDriveMemberEvent: vi.fn().mockResolvedValue(undefined),
  createDriveMemberEventPayload: vi.fn((driveId, userId, event, data) => ({
    driveId,
    userId,
    event,
    data,
  })),
  kickUserFromDrive: vi.fn().mockResolvedValue(undefined),
  kickUserFromDriveActivity: vi.fn().mockResolvedValue(undefined),
  kickUserFromPage: vi.fn().mockResolvedValue(undefined),
  kickUserFromPageActivity: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  getActorInfo: vi.fn().mockResolvedValue({
    actorEmail: 'test@example.com',
    actorDisplayName: 'Test User',
  }),
  logMemberActivity: vi.fn(),
  logPermissionActivity: vi.fn(),
}));

vi.mock('@pagespace/lib/activity-tracker', () => ({
  trackDriveOperation: vi.fn(),
}));

// Mock database for DELETE handler's transaction
vi.mock('@pagespace/db', () => {
  const mockTx = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    }),
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  };
  return {
    db: {
      transaction: vi.fn(async (callback) => callback(mockTx)),
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      }),
    },
    driveMembers: { driveId: 'driveId', userId: 'userId' },
    pagePermissions: { pageId: 'pageId', userId: 'userId', canView: 'canView', canEdit: 'canEdit', canShare: 'canShare', canDelete: 'canDelete', grantedBy: 'grantedBy', note: 'note' },
    pages: { id: 'id', driveId: 'driveId', title: 'title' },
    eq: vi.fn(),
    and: vi.fn(),
    inArray: vi.fn(),
  };
});

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

import {
  checkDriveAccess,
  getDriveMemberDetails,
  getMemberPermissions,
  updateMemberRole,
  updateMemberPermissions,
  loggers,
} from '@pagespace/lib/server';
import { createDriveNotification } from '@pagespace/lib';
import {
  broadcastDriveMemberEvent,
  createDriveMemberEventPayload,
  kickUserFromDrive,
  kickUserFromDriveActivity,
  kickUserFromPage,
  kickUserFromPageActivity,
} from '@/lib/websocket';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { trackDriveOperation } from '@pagespace/lib/monitoring/activity-tracker';
import { getActorInfo, logPermissionActivity } from '@pagespace/lib/monitoring/activity-logger';
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

const createDriveFixture = (overrides: {
  id: string;
  name: string;
  slug?: string;
  ownerId?: string;
}) => ({
  id: overrides.id,
  name: overrides.name,
  slug: overrides.slug ?? overrides.name.toLowerCase().replace(/\s+/g, '-'),
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

const createMemberDetailsFixture = (overrides: {
  id?: string;
  userId: string;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  email?: string;
}): MemberDetails => ({
  id: overrides.id ?? `mem_${overrides.userId}`,
  userId: overrides.userId,
  role: overrides.role,
  invitedBy: null,
  invitedAt: new Date('2024-01-01'),
  acceptedAt: new Date('2024-01-01'),
  lastAccessedAt: null,
  customRole: null,
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
});

const createPermissionFixture = (overrides: Partial<MemberPermission>): MemberPermission => ({
  pageId: overrides.pageId ?? 'page_1',
  canView: overrides.canView ?? false,
  canEdit: overrides.canEdit ?? false,
  canShare: overrides.canShare ?? false,
});

const createContext = (driveId: string, userId: string) => ({
  params: Promise.resolve({ driveId, userId }),
});

// ============================================================================
// GET /api/drives/[driveId]/members/[userId] - Contract Tests
// ============================================================================

describe('GET /api/drives/[driveId]/members/[userId]', () => {
  const mockCurrentUserId = 'user_123';
  const mockTargetUserId = 'user_456';
  const mockDriveId = 'drive_abc';

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockCurrentUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members/${mockTargetUserId}`);
      const response = await GET(request, createContext(mockDriveId, mockTargetUserId));

      expect(response.status).toBe(401);
    });

    it('should call authenticateRequestWithOptions with correct auth options', async () => {
      vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
      }));
      vi.mocked(getDriveMemberDetails).mockResolvedValue(
        createMemberDetailsFixture({ userId: mockTargetUserId, role: 'MEMBER' })
      );
      vi.mocked(getMemberPermissions).mockResolvedValue([]);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members/${mockTargetUserId}`);
      await GET(request, createContext(mockDriveId, mockTargetUserId));

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['session'], requireCSRF: false }
      );
    });
  });

  describe('authorization', () => {
    it('should return 404 when drive not found', async () => {
      vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({ drive: null }));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members/${mockTargetUserId}`);
      const response = await GET(request, createContext(mockDriveId, mockTargetUserId));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Drive not found');
    });

    it('should return 403 when user is not owner or admin', async () => {
      vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
        isOwner: false,
        isAdmin: false,
        isMember: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test', ownerId: 'other_user' }),
      }));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members/${mockTargetUserId}`);
      const response = await GET(request, createContext(mockDriveId, mockTargetUserId));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Only drive owners and admins can manage member settings');
    });

    it('should allow access for admin users', async () => {
      vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
        isOwner: false,
        isAdmin: true,
        isMember: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test', ownerId: 'other_user' }),
      }));
      vi.mocked(getDriveMemberDetails).mockResolvedValue(
        createMemberDetailsFixture({ userId: mockTargetUserId, role: 'MEMBER' })
      );
      vi.mocked(getMemberPermissions).mockResolvedValue([]);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members/${mockTargetUserId}`);
      const response = await GET(request, createContext(mockDriveId, mockTargetUserId));

      expect(response.status).toBe(200);
    });

    it('should return 404 when member not found', async () => {
      vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
      }));
      vi.mocked(getDriveMemberDetails).mockResolvedValue(null);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members/${mockTargetUserId}`);
      const response = await GET(request, createContext(mockDriveId, mockTargetUserId));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Member not found');
    });
  });

  describe('service integration', () => {
    it('should call checkDriveAccess with driveId and currentUserId', async () => {
      vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
      }));
      vi.mocked(getDriveMemberDetails).mockResolvedValue(
        createMemberDetailsFixture({ userId: mockTargetUserId, role: 'MEMBER' })
      );
      vi.mocked(getMemberPermissions).mockResolvedValue([]);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members/${mockTargetUserId}`);
      await GET(request, createContext(mockDriveId, mockTargetUserId));

      expect(checkDriveAccess).toHaveBeenCalledWith(mockDriveId, mockCurrentUserId);
    });

    it('should call getDriveMemberDetails with driveId and targetUserId', async () => {
      vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
      }));
      vi.mocked(getDriveMemberDetails).mockResolvedValue(
        createMemberDetailsFixture({ userId: mockTargetUserId, role: 'MEMBER' })
      );
      vi.mocked(getMemberPermissions).mockResolvedValue([]);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members/${mockTargetUserId}`);
      await GET(request, createContext(mockDriveId, mockTargetUserId));

      expect(getDriveMemberDetails).toHaveBeenCalledWith(mockDriveId, mockTargetUserId);
    });

    it('should call getMemberPermissions with driveId and targetUserId', async () => {
      vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
      }));
      vi.mocked(getDriveMemberDetails).mockResolvedValue(
        createMemberDetailsFixture({ userId: mockTargetUserId, role: 'MEMBER' })
      );
      vi.mocked(getMemberPermissions).mockResolvedValue([]);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members/${mockTargetUserId}`);
      await GET(request, createContext(mockDriveId, mockTargetUserId));

      expect(getMemberPermissions).toHaveBeenCalledWith(mockDriveId, mockTargetUserId);
    });
  });

  describe('response contract', () => {
    it('should return member details with drive info', async () => {
      const drive = createDriveFixture({ id: mockDriveId, name: 'Test Drive', slug: 'test-drive', ownerId: mockCurrentUserId });
      vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive,
      }));
      vi.mocked(getDriveMemberDetails).mockResolvedValue(
        createMemberDetailsFixture({ userId: mockTargetUserId, role: 'ADMIN', email: 'target@example.com' })
      );
      vi.mocked(getMemberPermissions).mockResolvedValue([]);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members/${mockTargetUserId}`);
      const response = await GET(request, createContext(mockDriveId, mockTargetUserId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.member).toMatchObject({
        userId: mockTargetUserId,
        role: 'ADMIN',
        user: { email: 'target@example.com' },
        drive: {
          id: mockDriveId,
          name: 'Test Drive',
          slug: 'test-drive',
          ownerId: mockCurrentUserId,
        },
      });
    });

    it('should return permissions array', async () => {
      const permissions = [
        createPermissionFixture({ pageId: 'page_1', canView: true, canEdit: true, canShare: false }),
        createPermissionFixture({ pageId: 'page_2', canView: true, canEdit: false, canShare: false }),
      ];

      vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
      }));
      vi.mocked(getDriveMemberDetails).mockResolvedValue(
        createMemberDetailsFixture({ userId: mockTargetUserId, role: 'MEMBER' })
      );
      vi.mocked(getMemberPermissions).mockResolvedValue(permissions);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members/${mockTargetUserId}`);
      const response = await GET(request, createContext(mockDriveId, mockTargetUserId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.permissions).toEqual(permissions);
    });

    it('should return empty permissions array when member has no permissions', async () => {
      vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
      }));
      vi.mocked(getDriveMemberDetails).mockResolvedValue(
        createMemberDetailsFixture({ userId: mockTargetUserId, role: 'MEMBER' })
      );
      vi.mocked(getMemberPermissions).mockResolvedValue([]);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members/${mockTargetUserId}`);
      const response = await GET(request, createContext(mockDriveId, mockTargetUserId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.permissions).toEqual([]);
    });
  });

  describe('error handling', () => {
    it('should return 500 when service throws', async () => {
      vi.mocked(checkDriveAccess).mockRejectedValueOnce(new Error('Database error'));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members/${mockTargetUserId}`);
      const response = await GET(request, createContext(mockDriveId, mockTargetUserId));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch member details');
    });

    it('should log error when service throws', async () => {
      const error = new Error('Service failure');
      vi.mocked(checkDriveAccess).mockRejectedValueOnce(error);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members/${mockTargetUserId}`);
      await GET(request, createContext(mockDriveId, mockTargetUserId));

      expect(loggers.api.error).toHaveBeenCalledWith('Error fetching member details:', error);
    });
  });
});

// ============================================================================
// PATCH /api/drives/[driveId]/members/[userId] - Contract Tests
// ============================================================================

describe('PATCH /api/drives/[driveId]/members/[userId]', () => {
  const mockCurrentUserId = 'user_123';
  const mockTargetUserId = 'user_456';
  const mockDriveId = 'drive_abc';

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockCurrentUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members/${mockTargetUserId}`, {
        method: 'PATCH',
        body: JSON.stringify({ permissions: [] }),
      });
      const response = await PATCH(request, createContext(mockDriveId, mockTargetUserId));

      expect(response.status).toBe(401);
    });

    it('should require CSRF for write operations', async () => {
      vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
      }));
      vi.mocked(getDriveMemberDetails).mockResolvedValue(
        createMemberDetailsFixture({ userId: mockTargetUserId, role: 'MEMBER' })
      );
      vi.mocked(updateMemberRole).mockResolvedValue({ oldRole: 'MEMBER' });
      vi.mocked(updateMemberPermissions).mockResolvedValue(0);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members/${mockTargetUserId}`, {
        method: 'PATCH',
        body: JSON.stringify({ permissions: [] }),
      });
      await PATCH(request, createContext(mockDriveId, mockTargetUserId));

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['session'], requireCSRF: true }
      );
    });
  });

  describe('validation', () => {
    it('should reject request without permissions array', async () => {
      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members/${mockTargetUserId}`, {
        method: 'PATCH',
        body: JSON.stringify({}),
      });
      const response = await PATCH(request, createContext(mockDriveId, mockTargetUserId));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid permissions data');
    });

    it('should reject non-array permissions', async () => {
      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members/${mockTargetUserId}`, {
        method: 'PATCH',
        body: JSON.stringify({ permissions: 'not-an-array' }),
      });
      const response = await PATCH(request, createContext(mockDriveId, mockTargetUserId));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid permissions data');
    });

    it('should reject invalid role', async () => {
      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members/${mockTargetUserId}`, {
        method: 'PATCH',
        body: JSON.stringify({ role: 'SUPERADMIN', permissions: [] }),
      });
      const response = await PATCH(request, createContext(mockDriveId, mockTargetUserId));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid role');
    });

    it('should accept ADMIN role', async () => {
      vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
      }));
      vi.mocked(getDriveMemberDetails).mockResolvedValue(
        createMemberDetailsFixture({ userId: mockTargetUserId, role: 'MEMBER' })
      );
      vi.mocked(updateMemberRole).mockResolvedValue({ oldRole: 'MEMBER' });
      vi.mocked(updateMemberPermissions).mockResolvedValue(0);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members/${mockTargetUserId}`, {
        method: 'PATCH',
        body: JSON.stringify({ role: 'ADMIN', permissions: [] }),
      });
      const response = await PATCH(request, createContext(mockDriveId, mockTargetUserId));

      expect(response.status).toBe(200);
    });

    it('should accept MEMBER role', async () => {
      vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
      }));
      vi.mocked(getDriveMemberDetails).mockResolvedValue(
        createMemberDetailsFixture({ userId: mockTargetUserId, role: 'ADMIN' })
      );
      vi.mocked(updateMemberRole).mockResolvedValue({ oldRole: 'ADMIN' });
      vi.mocked(updateMemberPermissions).mockResolvedValue(0);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members/${mockTargetUserId}`, {
        method: 'PATCH',
        body: JSON.stringify({ role: 'MEMBER', permissions: [] }),
      });
      const response = await PATCH(request, createContext(mockDriveId, mockTargetUserId));

      expect(response.status).toBe(200);
    });
  });

  describe('authorization', () => {
    it('should return 404 when drive not found', async () => {
      vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({ drive: null }));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members/${mockTargetUserId}`, {
        method: 'PATCH',
        body: JSON.stringify({ permissions: [] }),
      });
      const response = await PATCH(request, createContext(mockDriveId, mockTargetUserId));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Drive not found');
    });

    it('should return 403 when user is not owner or admin', async () => {
      vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
        isOwner: false,
        isAdmin: false,
        isMember: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test', ownerId: 'other_user' }),
      }));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members/${mockTargetUserId}`, {
        method: 'PATCH',
        body: JSON.stringify({ permissions: [] }),
      });
      const response = await PATCH(request, createContext(mockDriveId, mockTargetUserId));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Only drive owners and admins can manage member settings');
    });

    it('should return 404 when member not found', async () => {
      vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
      }));
      vi.mocked(getDriveMemberDetails).mockResolvedValue(null);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members/${mockTargetUserId}`, {
        method: 'PATCH',
        body: JSON.stringify({ permissions: [] }),
      });
      const response = await PATCH(request, createContext(mockDriveId, mockTargetUserId));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Member not found');
    });
  });

  describe('service integration', () => {
    it('should call checkDriveAccess with driveId and currentUserId', async () => {
      vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
      }));
      vi.mocked(getDriveMemberDetails).mockResolvedValue(
        createMemberDetailsFixture({ userId: mockTargetUserId, role: 'MEMBER' })
      );
      vi.mocked(updateMemberRole).mockResolvedValue({ oldRole: 'MEMBER' });
      vi.mocked(updateMemberPermissions).mockResolvedValue(0);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members/${mockTargetUserId}`, {
        method: 'PATCH',
        body: JSON.stringify({ permissions: [] }),
      });
      await PATCH(request, createContext(mockDriveId, mockTargetUserId));

      expect(checkDriveAccess).toHaveBeenCalledWith(mockDriveId, mockCurrentUserId);
    });

    it('should call getDriveMemberDetails to verify member exists', async () => {
      vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
      }));
      vi.mocked(getDriveMemberDetails).mockResolvedValue(
        createMemberDetailsFixture({ userId: mockTargetUserId, role: 'MEMBER' })
      );
      vi.mocked(updateMemberRole).mockResolvedValue({ oldRole: 'MEMBER' });
      vi.mocked(updateMemberPermissions).mockResolvedValue(0);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members/${mockTargetUserId}`, {
        method: 'PATCH',
        body: JSON.stringify({ permissions: [] }),
      });
      await PATCH(request, createContext(mockDriveId, mockTargetUserId));

      expect(getDriveMemberDetails).toHaveBeenCalledWith(mockDriveId, mockTargetUserId);
    });

    it('should call updateMemberRole with role and customRoleId', async () => {
      vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
      }));
      vi.mocked(getDriveMemberDetails).mockResolvedValue(
        createMemberDetailsFixture({ userId: mockTargetUserId, role: 'MEMBER' })
      );
      vi.mocked(updateMemberRole).mockResolvedValue({ oldRole: 'MEMBER' });
      vi.mocked(updateMemberPermissions).mockResolvedValue(0);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members/${mockTargetUserId}`, {
        method: 'PATCH',
        body: JSON.stringify({ role: 'ADMIN', customRoleId: 'role_123', permissions: [] }),
      });
      await PATCH(request, createContext(mockDriveId, mockTargetUserId));

      expect(updateMemberRole).toHaveBeenCalledWith(mockDriveId, mockTargetUserId, 'ADMIN', 'role_123');
    });

    it('should call updateMemberPermissions with permissions array', async () => {
      const permissions = [
        { pageId: 'page_1', canView: true, canEdit: true, canShare: false },
        { pageId: 'page_2', canView: true, canEdit: false, canShare: false },
      ];

      vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
      }));
      vi.mocked(getDriveMemberDetails).mockResolvedValue(
        createMemberDetailsFixture({ userId: mockTargetUserId, role: 'MEMBER' })
      );
      vi.mocked(updateMemberRole).mockResolvedValue({ oldRole: 'MEMBER' });
      vi.mocked(updateMemberPermissions).mockResolvedValue(2);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members/${mockTargetUserId}`, {
        method: 'PATCH',
        body: JSON.stringify({ permissions }),
      });
      await PATCH(request, createContext(mockDriveId, mockTargetUserId));

      expect(updateMemberPermissions).toHaveBeenCalledWith(
        mockDriveId,
        mockTargetUserId,
        mockCurrentUserId,
        permissions
      );
    });
  });

  describe('boundary obligations - notifications', () => {
    it('should send notification when role changes', async () => {
      vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test Drive' }),
      }));
      vi.mocked(getDriveMemberDetails).mockResolvedValue(
        createMemberDetailsFixture({ userId: mockTargetUserId, role: 'MEMBER' })
      );
      vi.mocked(updateMemberRole).mockResolvedValue({ oldRole: 'MEMBER' });
      vi.mocked(updateMemberPermissions).mockResolvedValue(0);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members/${mockTargetUserId}`, {
        method: 'PATCH',
        body: JSON.stringify({ role: 'ADMIN', permissions: [] }),
      });
      await PATCH(request, createContext(mockDriveId, mockTargetUserId));

      expect(createDriveNotification).toHaveBeenCalledWith(
        mockTargetUserId,
        mockDriveId,
        'role_changed',
        'ADMIN',
        mockCurrentUserId
      );
    });

    it('should broadcast event when role changes', async () => {
      vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test Drive' }),
      }));
      vi.mocked(getDriveMemberDetails).mockResolvedValue(
        createMemberDetailsFixture({ userId: mockTargetUserId, role: 'MEMBER' })
      );
      vi.mocked(updateMemberRole).mockResolvedValue({ oldRole: 'MEMBER' });
      vi.mocked(updateMemberPermissions).mockResolvedValue(0);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members/${mockTargetUserId}`, {
        method: 'PATCH',
        body: JSON.stringify({ role: 'ADMIN', permissions: [] }),
      });
      await PATCH(request, createContext(mockDriveId, mockTargetUserId));

      expect(createDriveMemberEventPayload).toHaveBeenCalledWith(
        mockDriveId,
        mockTargetUserId,
        'member_role_changed',
        { role: 'ADMIN', driveName: 'Test Drive' }
      );
      expect(broadcastDriveMemberEvent).toHaveBeenCalledTimes(1);
    });

    it('should NOT send notification when role stays the same', async () => {
      vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
      }));
      vi.mocked(getDriveMemberDetails).mockResolvedValue(
        createMemberDetailsFixture({ userId: mockTargetUserId, role: 'ADMIN' })
      );
      vi.mocked(updateMemberRole).mockResolvedValue({ oldRole: 'ADMIN' });
      vi.mocked(updateMemberPermissions).mockResolvedValue(0);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members/${mockTargetUserId}`, {
        method: 'PATCH',
        body: JSON.stringify({ role: 'ADMIN', permissions: [] }),
      });
      await PATCH(request, createContext(mockDriveId, mockTargetUserId));

      expect(createDriveNotification).not.toHaveBeenCalled();
      expect(broadcastDriveMemberEvent).not.toHaveBeenCalled();
    });

    it('should NOT send notification when no role is provided', async () => {
      vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
      }));
      vi.mocked(getDriveMemberDetails).mockResolvedValue(
        createMemberDetailsFixture({ userId: mockTargetUserId, role: 'MEMBER' })
      );
      vi.mocked(updateMemberRole).mockResolvedValue({ oldRole: 'MEMBER' });
      vi.mocked(updateMemberPermissions).mockResolvedValue(2);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members/${mockTargetUserId}`, {
        method: 'PATCH',
        body: JSON.stringify({ permissions: [{ pageId: 'page_1', canView: true }] }),
      });
      await PATCH(request, createContext(mockDriveId, mockTargetUserId));

      expect(createDriveNotification).not.toHaveBeenCalled();
      expect(broadcastDriveMemberEvent).not.toHaveBeenCalled();
    });
  });

  describe('response contract', () => {
    it('should return success with permissionsUpdated count', async () => {
      vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
      }));
      vi.mocked(getDriveMemberDetails).mockResolvedValue(
        createMemberDetailsFixture({ userId: mockTargetUserId, role: 'MEMBER' })
      );
      vi.mocked(updateMemberRole).mockResolvedValue({ oldRole: 'MEMBER' });
      vi.mocked(updateMemberPermissions).mockResolvedValue(5);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members/${mockTargetUserId}`, {
        method: 'PATCH',
        body: JSON.stringify({ permissions: [] }),
      });
      const response = await PATCH(request, createContext(mockDriveId, mockTargetUserId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({
        success: true,
        message: 'Permissions updated successfully',
        permissionsUpdated: 5,
      });
    });

    it('should return 0 permissionsUpdated when no permissions are set', async () => {
      vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
      }));
      vi.mocked(getDriveMemberDetails).mockResolvedValue(
        createMemberDetailsFixture({ userId: mockTargetUserId, role: 'MEMBER' })
      );
      vi.mocked(updateMemberRole).mockResolvedValue({ oldRole: 'MEMBER' });
      vi.mocked(updateMemberPermissions).mockResolvedValue(0);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members/${mockTargetUserId}`, {
        method: 'PATCH',
        body: JSON.stringify({ permissions: [] }),
      });
      const response = await PATCH(request, createContext(mockDriveId, mockTargetUserId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.permissionsUpdated).toBe(0);
    });
  });

  describe('error handling', () => {
    it('should return 500 when service throws', async () => {
      vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
      }));
      vi.mocked(getDriveMemberDetails).mockResolvedValue(
        createMemberDetailsFixture({ userId: mockTargetUserId, role: 'MEMBER' })
      );
      vi.mocked(updateMemberRole).mockRejectedValueOnce(new Error('Update failed'));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members/${mockTargetUserId}`, {
        method: 'PATCH',
        body: JSON.stringify({ role: 'ADMIN', permissions: [] }),
      });
      const response = await PATCH(request, createContext(mockDriveId, mockTargetUserId));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to update member permissions');
    });

    it('should log error when service throws', async () => {
      const error = new Error('Service failure');
      vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
      }));
      vi.mocked(getDriveMemberDetails).mockResolvedValue(
        createMemberDetailsFixture({ userId: mockTargetUserId, role: 'MEMBER' })
      );
      vi.mocked(updateMemberRole).mockRejectedValueOnce(error);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members/${mockTargetUserId}`, {
        method: 'PATCH',
        body: JSON.stringify({ role: 'ADMIN', permissions: [] }),
      });
      await PATCH(request, createContext(mockDriveId, mockTargetUserId));

      expect(loggers.api.error).toHaveBeenCalledWith('Error updating member permissions:', error);
    });
  });
});

// ============================================================================
// DELETE /api/drives/[driveId]/members/[userId] - Contract Tests
// ============================================================================

describe('DELETE /api/drives/[driveId]/members/[userId]', () => {
  const mockCurrentUserId = 'user_123';
  const mockTargetUserId = 'user_456';
  const mockDriveId = 'drive_abc';
  const mockDriveOwnerId = 'owner_789';

  // Helper to create a mockTx with configurable drivePages and permissions
  function createMockTx(drivePages: { id: string; title: string }[] = [], existingPermissions: Record<string, unknown>[] = []) {
    let selectCallCount = 0;
    return {
      select: vi.fn().mockImplementation(() => ({
        from: vi.fn().mockImplementation(() => ({
          where: vi.fn().mockImplementation(() => {
            selectCallCount++;
            // First select: drivePages, Second select: existingPermissions
            return Promise.resolve(selectCallCount === 1 ? drivePages : existingPermissions);
          }),
        })),
      })),
      delete: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    };
  }

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockCurrentUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    // Default: db.select for page kicks returns no pages
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    } as never);

    // Re-set up db.transaction after resetAllMocks - default: empty drive (no pages)
    // @ts-expect-error - partial mock data
    vi.mocked(db.transaction).mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => {
      const mockTx = createMockTx();
      return callback(mockTx);
    });

    // Re-set up activity logger mocks
    vi.mocked(getActorInfo).mockResolvedValue({ actorEmail: 'test@example.com', actorDisplayName: 'Test User' } as never);
  });

  const createDeleteRequest = () => {
    return new Request(`https://example.com/api/drives/${mockDriveId}/members/${mockTargetUserId}`, {
      method: 'DELETE',
    });
  };

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const response = await DELETE(createDeleteRequest(), createContext(mockDriveId, mockTargetUserId));

      expect(response.status).toBe(401);
    });

    it('should require CSRF for write operations', async () => {
      vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test', ownerId: mockDriveOwnerId }),
      }));
      vi.mocked(getDriveMemberDetails).mockResolvedValue(
        createMemberDetailsFixture({ userId: mockTargetUserId, role: 'MEMBER' })
      );

      const request = createDeleteRequest();
      await DELETE(request, createContext(mockDriveId, mockTargetUserId));

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['session'], requireCSRF: true }
      );
    });
  });

  describe('authorization', () => {
    it('should return 404 when drive not found', async () => {
      vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({ drive: null }));

      const response = await DELETE(createDeleteRequest(), createContext(mockDriveId, mockTargetUserId));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Drive not found');
    });

    it('should return 403 when user is not owner or admin', async () => {
      vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
        isOwner: false,
        isAdmin: false,
        isMember: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test', ownerId: mockDriveOwnerId }),
      }));

      const response = await DELETE(createDeleteRequest(), createContext(mockDriveId, mockTargetUserId));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Only drive owners and admins can remove members');
    });

    it('should return 400 when trying to remove the drive owner', async () => {
      vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test', ownerId: mockTargetUserId }),
      }));

      const response = await DELETE(createDeleteRequest(), createContext(mockDriveId, mockTargetUserId));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Cannot remove the drive owner');
    });

    it('should return 400 when trying to remove yourself', async () => {
      // Create context where the target user IS the current user
      const selfContext = createContext(mockDriveId, mockCurrentUserId);
      vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test', ownerId: mockDriveOwnerId }),
      }));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members/${mockCurrentUserId}`, {
        method: 'DELETE',
      });

      const response = await DELETE(request, selfContext);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Cannot remove yourself. Use leave drive instead.');
    });

    it('should return 404 when member not found', async () => {
      vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test', ownerId: mockDriveOwnerId }),
      }));
      vi.mocked(getDriveMemberDetails).mockResolvedValue(null);

      const response = await DELETE(createDeleteRequest(), createContext(mockDriveId, mockTargetUserId));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Member not found');
    });
  });

  describe('successful member removal', () => {
    beforeEach(() => {
      vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test Drive', ownerId: mockDriveOwnerId }),
      }));
      vi.mocked(getDriveMemberDetails).mockResolvedValue(
        createMemberDetailsFixture({ userId: mockTargetUserId, role: 'MEMBER' })
      );
    });

    it('should return success message on successful removal', async () => {
      const response = await DELETE(createDeleteRequest(), createContext(mockDriveId, mockTargetUserId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.message).toBe('Member removed successfully');
    });

    it('should execute removal in a transaction', async () => {
      await DELETE(createDeleteRequest(), createContext(mockDriveId, mockTargetUserId));

      expect(db.transaction).toHaveBeenCalledTimes(1);
      const transactionCallback = vi.mocked(db.transaction).mock.calls[0][0];
      expect(typeof transactionCallback).toBe('function');
    });

    it('should track drive operation', async () => {
      await DELETE(createDeleteRequest(), createContext(mockDriveId, mockTargetUserId));

      expect(trackDriveOperation).toHaveBeenCalledWith(
        mockCurrentUserId,
        'remove_member',
        mockDriveId,
        expect.objectContaining({
          targetUserId: mockTargetUserId,
          role: 'MEMBER',
        })
      );
    });

    it('should broadcast member removal event', async () => {
      await DELETE(createDeleteRequest(), createContext(mockDriveId, mockTargetUserId));

      expect(createDriveMemberEventPayload).toHaveBeenCalledWith(
        mockDriveId,
        mockTargetUserId,
        'member_removed',
        { driveName: 'Test Drive' }
      );
      expect(broadcastDriveMemberEvent).toHaveBeenCalledTimes(1);
    });

    it('should kick user from drive rooms', async () => {
      await DELETE(createDeleteRequest(), createContext(mockDriveId, mockTargetUserId));

      expect(kickUserFromDrive).toHaveBeenCalledWith(
        mockDriveId,
        mockTargetUserId,
        'member_removed',
        'Test Drive'
      );
      expect(kickUserFromDriveActivity).toHaveBeenCalledWith(
        mockDriveId,
        mockTargetUserId,
        'member_removed'
      );
    });

    it('should kick user from page rooms when drive has pages', async () => {
      // Drive has pages
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { id: 'page_1' },
            { id: 'page_2' },
          ]),
        }),
      } as never);

      await DELETE(createDeleteRequest(), createContext(mockDriveId, mockTargetUserId));

      expect(kickUserFromPage).toHaveBeenCalledWith('page_1', mockTargetUserId, 'member_removed');
      expect(kickUserFromPage).toHaveBeenCalledWith('page_2', mockTargetUserId, 'member_removed');
      expect(kickUserFromPageActivity).toHaveBeenCalledWith('page_1', mockTargetUserId, 'member_removed');
      expect(kickUserFromPageActivity).toHaveBeenCalledWith('page_2', mockTargetUserId, 'member_removed');
    });

    it('should log permission revocations and delete permissions when drive has pages', async () => {
      const drivePages = [
        { id: 'page_1', title: 'Page One' },
        { id: 'page_2', title: 'Page Two' },
      ];
      const existingPermissions = [
        { pageId: 'page_1', canView: true, canEdit: true, canShare: false, canDelete: false, grantedBy: mockCurrentUserId, note: 'test' },
        { pageId: 'page_2', canView: true, canEdit: false, canShare: false, canDelete: false, grantedBy: mockCurrentUserId, note: null },
      ];

      // @ts-expect-error - partial mock data
      vi.mocked(db.transaction).mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => {
        const mockTx = createMockTx(drivePages, existingPermissions);
        return callback(mockTx);
      });

      const response = await DELETE(createDeleteRequest(), createContext(mockDriveId, mockTargetUserId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);

      // logPermissionActivity should be called for each existing permission
      expect(logPermissionActivity).toHaveBeenCalledTimes(2);
      expect(logPermissionActivity).toHaveBeenCalledWith(
        mockCurrentUserId,
        'permission_revoke',
        expect.objectContaining({ pageId: 'page_1', driveId: mockDriveId, targetUserId: mockTargetUserId, pageTitle: 'Page One' }),
        expect.objectContaining({ reason: 'member_removal', previousValues: expect.objectContaining({ canView: true, canEdit: true }) })
      );
    });

    it('should delete drive membership even when drive has no pages', async () => {
      // Explicitly set empty drivePages
      // @ts-expect-error - partial mock data
      vi.mocked(db.transaction).mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => {
        const mockTx = createMockTx([], []);
        return callback(mockTx);
      });

      const response = await DELETE(createDeleteRequest(), createContext(mockDriveId, mockTargetUserId));

      expect(response.status).toBe(200);
      expect(db.transaction).toHaveBeenCalledTimes(1);
      const transactionCallback = vi.mocked(db.transaction).mock.calls[0][0];
      expect(typeof transactionCallback).toBe('function');
    });

    it('should handle pages with no matching permissions gracefully', async () => {
      const drivePages = [{ id: 'page_1', title: 'Page One' }];
      // No existing permissions for this user
      const existingPermissions: Record<string, unknown>[] = [];

      // @ts-expect-error - partial mock data
      vi.mocked(db.transaction).mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => {
        const mockTx = createMockTx(drivePages, existingPermissions);
        return callback(mockTx);
      });

      const response = await DELETE(createDeleteRequest(), createContext(mockDriveId, mockTargetUserId));

      expect(response.status).toBe(200);
      // No permission revocations should be logged
      expect(logPermissionActivity).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should return 500 when service throws', async () => {
      vi.mocked(checkDriveAccess).mockRejectedValueOnce(new Error('Database error'));

      const response = await DELETE(createDeleteRequest(), createContext(mockDriveId, mockTargetUserId));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to remove member');
    });

    it('should log error when service throws', async () => {
      const error = new Error('Service failure');
      vi.mocked(checkDriveAccess).mockRejectedValueOnce(error);

      await DELETE(createDeleteRequest(), createContext(mockDriveId, mockTargetUserId));

      expect(loggers.api.error).toHaveBeenCalledWith('Error removing member:', error);
    });
  });
});
