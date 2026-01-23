import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { GET, PATCH } from '../route';
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
}));

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
import { broadcastDriveMemberEvent, createDriveMemberEventPayload } from '@/lib/websocket';
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
      vi.mocked(checkDriveAccess).mockRejectedValue(new Error('Database error'));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members/${mockTargetUserId}`);
      const response = await GET(request, createContext(mockDriveId, mockTargetUserId));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch member details');
    });

    it('should log error when service throws', async () => {
      const error = new Error('Service failure');
      vi.mocked(checkDriveAccess).mockRejectedValue(error);

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
      expect(broadcastDriveMemberEvent).toHaveBeenCalled();
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
      vi.mocked(updateMemberRole).mockRejectedValue(new Error('Update failed'));

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
      vi.mocked(updateMemberRole).mockRejectedValue(error);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members/${mockTargetUserId}`, {
        method: 'PATCH',
        body: JSON.stringify({ role: 'ADMIN', permissions: [] }),
      });
      await PATCH(request, createContext(mockDriveId, mockTargetUserId));

      expect(loggers.api.error).toHaveBeenCalledWith('Error updating member permissions:', error);
    });
  });
});
