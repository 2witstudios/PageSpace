import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { PATCH } from '../route';
import type { WebAuthResult, AuthError } from '@/lib/auth';
import type { DriveRoleAccessInfo } from '@pagespace/lib/server';

// ============================================================================
// Contract Tests for /api/drives/[driveId]/roles/reorder
//
// These tests mock at the SERVICE SEAM level, NOT at the ORM/query-builder level.
// ============================================================================

vi.mock('@pagespace/lib/server', () => ({
  checkDriveAccessForRoles: vi.fn(),
  reorderDriveRoles: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

// Mock activity logger (boundary)
vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  getActorInfo: vi.fn(),
  logRoleActivity: vi.fn(),
}));

// Mock database for previous order query
const { mockOrderBy, mockWhere, mockFrom, mockSelect } = vi.hoisted(() => {
  const mockOrderBy = vi.fn();
  const mockWhere = vi.fn().mockReturnValue({ orderBy: mockOrderBy });
  const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
  const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });
  return { mockOrderBy, mockWhere, mockFrom, mockSelect };
});

vi.mock('@pagespace/db', () => ({
  db: {
    select: mockSelect,
  },
  driveRoles: {},
  eq: vi.fn(),
  asc: vi.fn(),
}));

import {
  checkDriveAccessForRoles,
  reorderDriveRoles,
} from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { getActorInfo, logRoleActivity } from '@pagespace/lib/monitoring/activity-logger';

// ============================================================================
// Test Fixtures
// ============================================================================

const mockWebAuth = (userId: string, tokenVersion = 0): WebAuthResult => ({
  userId,
  tokenVersion,
  tokenType: 'jwt',
  source: 'cookie',
  role: 'user',
});

const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

const createDriveFixture = (overrides: { id: string; name: string; ownerId?: string }) => ({
  id: overrides.id,
  name: overrides.name,
  slug: overrides.name.toLowerCase().replace(/\s+/g, '-'),
  ownerId: overrides.ownerId ?? 'user_123',
});

const createAccessFixture = (overrides: Partial<DriveRoleAccessInfo>): DriveRoleAccessInfo => ({
  isOwner: overrides.isOwner ?? false,
  isAdmin: overrides.isAdmin ?? false,
  isMember: overrides.isMember ?? false,
  drive: overrides.drive ?? null,
});

const createContext = (driveId: string) => ({
  params: Promise.resolve({ driveId }),
});

// ============================================================================
// PATCH /api/drives/[driveId]/roles/reorder - Contract Tests
// ============================================================================

describe('PATCH /api/drives/[driveId]/roles/reorder', () => {
  const mockUserId = 'user_123';
  const mockDriveId = 'drive_abc';

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    // Re-setup the chained mock after resetAllMocks
    mockSelect.mockReturnValue({ from: mockFrom });
    mockFrom.mockReturnValue({ where: mockWhere });
    mockWhere.mockReturnValue({ orderBy: mockOrderBy });

    // Default: previous order query returns roles
    mockOrderBy.mockResolvedValue([
      { id: 'role_1' },
      { id: 'role_2' },
      { id: 'role_3' },
    ]);

    // Default: actor info for activity logging
    vi.mocked(getActorInfo).mockResolvedValue({
      actorEmail: 'test@example.com',
      actorDisplayName: 'Test User',
    });
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/reorder`, {
        method: 'PATCH',
        body: JSON.stringify({ roleIds: ['role_1', 'role_2'] }),
      });
      const response = await PATCH(request, createContext(mockDriveId));

      expect(response.status).toBe(401);
    });

    it('should require CSRF for write operations', async () => {
      vi.mocked(checkDriveAccessForRoles).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
      }));
      vi.mocked(reorderDriveRoles).mockResolvedValue(undefined);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/reorder`, {
        method: 'PATCH',
        body: JSON.stringify({ roleIds: ['role_1', 'role_2'] }),
      });
      await PATCH(request, createContext(mockDriveId));

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['jwt'], requireCSRF: true }
      );
    });
  });

  describe('authorization', () => {
    it('should return 404 when drive not found', async () => {
      vi.mocked(checkDriveAccessForRoles).mockResolvedValue(createAccessFixture({ drive: null }));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/reorder`, {
        method: 'PATCH',
        body: JSON.stringify({ roleIds: ['role_1', 'role_2'] }),
      });
      const response = await PATCH(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Drive not found');
    });

    it('should return 403 when user is not owner or admin', async () => {
      vi.mocked(checkDriveAccessForRoles).mockResolvedValue(createAccessFixture({
        isOwner: false,
        isAdmin: false,
        isMember: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Other', ownerId: 'other_user' }),
      }));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/reorder`, {
        method: 'PATCH',
        body: JSON.stringify({ roleIds: ['role_1', 'role_2'] }),
      });
      const response = await PATCH(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Only owners and admins can reorder roles');
    });

    it('should allow admin to reorder roles', async () => {
      vi.mocked(checkDriveAccessForRoles).mockResolvedValue(createAccessFixture({
        isOwner: false,
        isAdmin: true,
        isMember: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Shared', ownerId: 'other_user' }),
      }));
      vi.mocked(reorderDriveRoles).mockResolvedValue(undefined);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/reorder`, {
        method: 'PATCH',
        body: JSON.stringify({ roleIds: ['role_2', 'role_1'] }),
      });
      const response = await PATCH(request, createContext(mockDriveId));

      expect(response.status).toBe(200);
    });
  });

  describe('validation', () => {
    beforeEach(() => {
      vi.mocked(checkDriveAccessForRoles).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test', ownerId: mockUserId }),
      }));
    });

    it('should reject when roleIds is not an array', async () => {
      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/reorder`, {
        method: 'PATCH',
        body: JSON.stringify({ roleIds: 'not-an-array' }),
      });
      const response = await PATCH(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('roleIds must be an array');
    });

    it('should reject when roleIds is null', async () => {
      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/reorder`, {
        method: 'PATCH',
        body: JSON.stringify({ roleIds: null }),
      });
      const response = await PATCH(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('roleIds must be an array');
    });

    it('should reject when roleIds contains invalid IDs', async () => {
      vi.mocked(reorderDriveRoles).mockRejectedValue(new Error('Invalid role IDs'));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/reorder`, {
        method: 'PATCH',
        body: JSON.stringify({ roleIds: ['role_1', 'role_invalid'] }),
      });
      const response = await PATCH(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid role IDs');
    });
  });

  describe('service integration', () => {
    it('should call reorderDriveRoles with driveId and roleIds', async () => {
      vi.mocked(checkDriveAccessForRoles).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
      }));
      vi.mocked(reorderDriveRoles).mockResolvedValue(undefined);

      const roleIds = ['role_3', 'role_1', 'role_2'];
      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/reorder`, {
        method: 'PATCH',
        body: JSON.stringify({ roleIds }),
      });
      await PATCH(request, createContext(mockDriveId));

      expect(reorderDriveRoles).toHaveBeenCalledWith(mockDriveId, roleIds);
    });
  });

  describe('response contract', () => {
    it('should return success=true on successful reorder', async () => {
      vi.mocked(checkDriveAccessForRoles).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
      }));
      vi.mocked(reorderDriveRoles).mockResolvedValue(undefined);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/reorder`, {
        method: 'PATCH',
        body: JSON.stringify({ roleIds: ['role_3', 'role_1', 'role_2'] }),
      });
      const response = await PATCH(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });

    it('should handle empty roleIds array', async () => {
      vi.mocked(checkDriveAccessForRoles).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
      }));
      vi.mocked(reorderDriveRoles).mockResolvedValue(undefined);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/reorder`, {
        method: 'PATCH',
        body: JSON.stringify({ roleIds: [] }),
      });
      const response = await PATCH(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should return 500 when service throws unexpected error', async () => {
      vi.mocked(checkDriveAccessForRoles).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
      }));
      vi.mocked(reorderDriveRoles).mockRejectedValue(new Error('Transaction failed'));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/reorder`, {
        method: 'PATCH',
        body: JSON.stringify({ roleIds: ['role_1'] }),
      });
      const response = await PATCH(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to reorder roles');
    });
  });

  describe('activity logging boundary', () => {
    it('should log role_reorder with previous and new order on success', async () => {
      vi.mocked(checkDriveAccessForRoles).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test Drive' }),
      }));
      vi.mocked(reorderDriveRoles).mockResolvedValue(undefined);

      const newOrder = ['role_3', 'role_1', 'role_2'];
      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/reorder`, {
        method: 'PATCH',
        body: JSON.stringify({ roleIds: newOrder }),
      });
      await PATCH(request, createContext(mockDriveId));

      expect(logRoleActivity).toHaveBeenCalledWith(
        mockUserId,
        'role_reorder',
        expect.objectContaining({
          driveId: mockDriveId,
          driveName: 'Test Drive',
          previousOrder: ['role_1', 'role_2', 'role_3'],
          newOrder: newOrder,
        }),
        expect.objectContaining({
          actorEmail: 'test@example.com',
        })
      );
    });

    it('should call getActorInfo with userId', async () => {
      vi.mocked(checkDriveAccessForRoles).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
      }));
      vi.mocked(reorderDriveRoles).mockResolvedValue(undefined);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/reorder`, {
        method: 'PATCH',
        body: JSON.stringify({ roleIds: ['role_1'] }),
      });
      await PATCH(request, createContext(mockDriveId));

      expect(getActorInfo).toHaveBeenCalledWith(mockUserId);
    });

    it('should NOT log activity when authentication fails', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/reorder`, {
        method: 'PATCH',
        body: JSON.stringify({ roleIds: ['role_1'] }),
      });
      await PATCH(request, createContext(mockDriveId));

      expect(logRoleActivity).not.toHaveBeenCalled();
    });

    it('should NOT log activity when drive not found', async () => {
      vi.mocked(checkDriveAccessForRoles).mockResolvedValue(createAccessFixture({ drive: null }));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/reorder`, {
        method: 'PATCH',
        body: JSON.stringify({ roleIds: ['role_1'] }),
      });
      await PATCH(request, createContext(mockDriveId));

      expect(logRoleActivity).not.toHaveBeenCalled();
    });

    it('should NOT log activity when user lacks permission', async () => {
      vi.mocked(checkDriveAccessForRoles).mockResolvedValue(createAccessFixture({
        isOwner: false,
        isAdmin: false,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
      }));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/reorder`, {
        method: 'PATCH',
        body: JSON.stringify({ roleIds: ['role_1'] }),
      });
      await PATCH(request, createContext(mockDriveId));

      expect(logRoleActivity).not.toHaveBeenCalled();
    });

    it('should NOT log activity when roleIds validation fails', async () => {
      vi.mocked(checkDriveAccessForRoles).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
      }));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/reorder`, {
        method: 'PATCH',
        body: JSON.stringify({ roleIds: 'not-an-array' }),
      });
      await PATCH(request, createContext(mockDriveId));

      expect(logRoleActivity).not.toHaveBeenCalled();
    });
  });
});
