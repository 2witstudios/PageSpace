import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { GET, PATCH, DELETE } from '../route';
import type { SessionAuthResult, AuthError } from '@/lib/auth';
import type { DriveRoleAccessInfo, DriveRole, RolePermissions } from '@pagespace/lib/server';

// ============================================================================
// Contract Tests for /api/drives/[driveId]/roles/[roleId]
//
// These tests mock at the SERVICE SEAM level, NOT at the ORM/query-builder level.
// ============================================================================

vi.mock('@pagespace/lib/server', () => ({
  checkDriveAccessForRoles: vi.fn(),
  getRoleById: vi.fn(),
  updateDriveRole: vi.fn(),
  deleteDriveRole: vi.fn(),
  validateRolePermissions: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

import {
  checkDriveAccessForRoles,
  getRoleById,
  updateDriveRole,
  deleteDriveRole,
  validateRolePermissions,
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

const createRoleFixture = (overrides: {
  id: string;
  name: string;
  driveId: string;
  position?: number;
  isDefault?: boolean;
  permissions?: RolePermissions;
}): DriveRole => ({
  id: overrides.id,
  driveId: overrides.driveId,
  name: overrides.name,
  description: null,
  color: '#000000',
  isDefault: overrides.isDefault ?? false,
  permissions: overrides.permissions ?? { page_1: { canView: true, canEdit: false, canShare: false } },
  position: overrides.position ?? 0,
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
});

const createContext = (driveId: string, roleId: string) => ({
  params: Promise.resolve({ driveId, roleId }),
});

// ============================================================================
// GET /api/drives/[driveId]/roles/[roleId] - Contract Tests
// ============================================================================

describe('GET /api/drives/[driveId]/roles/[roleId]', () => {
  const mockUserId = 'user_123';
  const mockDriveId = 'drive_abc';
  const mockRoleId = 'role_xyz';

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/${mockRoleId}`);
      const response = await GET(request, createContext(mockDriveId, mockRoleId));

      expect(response.status).toBe(401);
    });
  });

  describe('authorization', () => {
    it('should return 404 when drive not found', async () => {
      vi.mocked(checkDriveAccessForRoles).mockResolvedValue(createAccessFixture({ drive: null }));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/${mockRoleId}`);
      const response = await GET(request, createContext(mockDriveId, mockRoleId));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Drive not found');
    });

    it('should return 403 when user is not owner or member', async () => {
      vi.mocked(checkDriveAccessForRoles).mockResolvedValue(createAccessFixture({
        isOwner: false,
        isMember: false,
        drive: createDriveFixture({ id: mockDriveId, name: 'Other', ownerId: 'other_user' }),
      }));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/${mockRoleId}`);
      const response = await GET(request, createContext(mockDriveId, mockRoleId));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Not a member of this drive');
    });
  });

  describe('service integration', () => {
    it('should call checkDriveAccessForRoles with driveId and userId', async () => {
      vi.mocked(checkDriveAccessForRoles).mockResolvedValue(createAccessFixture({
        isOwner: true,
        isMember: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
      }));
      vi.mocked(getRoleById).mockResolvedValue(
        createRoleFixture({ id: mockRoleId, name: 'Test', driveId: mockDriveId })
      );

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/${mockRoleId}`);
      await GET(request, createContext(mockDriveId, mockRoleId));

      expect(checkDriveAccessForRoles).toHaveBeenCalledWith(mockDriveId, mockUserId);
    });

    it('should call getRoleById with driveId and roleId', async () => {
      vi.mocked(checkDriveAccessForRoles).mockResolvedValue(createAccessFixture({
        isOwner: true,
        isMember: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
      }));
      vi.mocked(getRoleById).mockResolvedValue(
        createRoleFixture({ id: mockRoleId, name: 'Test', driveId: mockDriveId })
      );

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/${mockRoleId}`);
      await GET(request, createContext(mockDriveId, mockRoleId));

      expect(getRoleById).toHaveBeenCalledWith(mockDriveId, mockRoleId);
    });
  });

  describe('response contract', () => {
    it('should return 404 when role not found', async () => {
      vi.mocked(checkDriveAccessForRoles).mockResolvedValue(createAccessFixture({
        isOwner: true,
        isMember: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test', ownerId: mockUserId }),
      }));
      vi.mocked(getRoleById).mockResolvedValue(null);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/${mockRoleId}`);
      const response = await GET(request, createContext(mockDriveId, mockRoleId));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Role not found');
    });

    it('should return role when user is owner', async () => {
      const role = createRoleFixture({ id: mockRoleId, name: 'Editor', driveId: mockDriveId });

      vi.mocked(checkDriveAccessForRoles).mockResolvedValue(createAccessFixture({
        isOwner: true,
        isMember: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test', ownerId: mockUserId }),
      }));
      vi.mocked(getRoleById).mockResolvedValue(role);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/${mockRoleId}`);
      const response = await GET(request, createContext(mockDriveId, mockRoleId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.role).toMatchObject({
        id: mockRoleId,
        name: 'Editor',
      });
    });

    it('should return role when user is member', async () => {
      const role = createRoleFixture({ id: mockRoleId, name: 'Viewer', driveId: mockDriveId });

      vi.mocked(checkDriveAccessForRoles).mockResolvedValue(createAccessFixture({
        isOwner: false,
        isMember: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Shared', ownerId: 'other_user' }),
      }));
      vi.mocked(getRoleById).mockResolvedValue(role);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/${mockRoleId}`);
      const response = await GET(request, createContext(mockDriveId, mockRoleId));

      expect(response.status).toBe(200);
    });
  });

  describe('error handling', () => {
    it('should return 500 when service throws', async () => {
      vi.mocked(checkDriveAccessForRoles).mockRejectedValue(new Error('Database error'));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/${mockRoleId}`);
      const response = await GET(request, createContext(mockDriveId, mockRoleId));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch role');
    });
  });
});

// ============================================================================
// PATCH /api/drives/[driveId]/roles/[roleId] - Contract Tests
// ============================================================================

describe('PATCH /api/drives/[driveId]/roles/[roleId]', () => {
  const mockUserId = 'user_123';
  const mockDriveId = 'drive_abc';
  const mockRoleId = 'role_xyz';

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(validateRolePermissions).mockReturnValue(true);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/${mockRoleId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Updated' }),
      });
      const response = await PATCH(request, createContext(mockDriveId, mockRoleId));

      expect(response.status).toBe(401);
    });

    it('should require CSRF for write operations', async () => {
      vi.mocked(checkDriveAccessForRoles).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
      }));
      vi.mocked(getRoleById).mockResolvedValue(
        createRoleFixture({ id: mockRoleId, name: 'Original', driveId: mockDriveId })
      );
      vi.mocked(updateDriveRole).mockResolvedValue({
        role: createRoleFixture({ id: mockRoleId, name: 'Updated', driveId: mockDriveId }),
        wasDefault: false,
      });

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/${mockRoleId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Updated' }),
      });
      await PATCH(request, createContext(mockDriveId, mockRoleId));

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['session'], requireCSRF: true }
      );
    });
  });

  describe('authorization', () => {
    it('should return 404 when drive not found', async () => {
      vi.mocked(checkDriveAccessForRoles).mockResolvedValue(createAccessFixture({ drive: null }));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/${mockRoleId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Updated' }),
      });
      const response = await PATCH(request, createContext(mockDriveId, mockRoleId));
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

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/${mockRoleId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Updated' }),
      });
      const response = await PATCH(request, createContext(mockDriveId, mockRoleId));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Only owners and admins can update roles');
    });

    it('should allow admin to update role', async () => {
      vi.mocked(checkDriveAccessForRoles).mockResolvedValue(createAccessFixture({
        isOwner: false,
        isAdmin: true,
        isMember: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Shared', ownerId: 'other_user' }),
      }));
      vi.mocked(getRoleById).mockResolvedValue(
        createRoleFixture({ id: mockRoleId, name: 'Original', driveId: mockDriveId })
      );
      vi.mocked(updateDriveRole).mockResolvedValue({
        role: createRoleFixture({ id: mockRoleId, name: 'Updated', driveId: mockDriveId }),
        wasDefault: false,
      });

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/${mockRoleId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Updated' }),
      });
      const response = await PATCH(request, createContext(mockDriveId, mockRoleId));

      expect(response.status).toBe(200);
    });
  });

  describe('validation', () => {
    beforeEach(() => {
      vi.mocked(checkDriveAccessForRoles).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test', ownerId: mockUserId }),
      }));
      vi.mocked(getRoleById).mockResolvedValue(
        createRoleFixture({ id: mockRoleId, name: 'Original', driveId: mockDriveId })
      );
    });

    it('should reject empty name', async () => {
      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/${mockRoleId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: '   ' }),
      });
      const response = await PATCH(request, createContext(mockDriveId, mockRoleId));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Role name must be between 1 and 50 characters');
    });

    it('should reject name longer than 50 characters', async () => {
      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/${mockRoleId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: 'a'.repeat(51) }),
      });
      const response = await PATCH(request, createContext(mockDriveId, mockRoleId));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Role name must be between 1 and 50 characters');
    });

    it('should reject invalid permissions structure', async () => {
      vi.mocked(validateRolePermissions).mockReturnValue(false);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/${mockRoleId}`, {
        method: 'PATCH',
        body: JSON.stringify({ permissions: 'invalid' }),
      });
      const response = await PATCH(request, createContext(mockDriveId, mockRoleId));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid permissions structure');
    });
  });

  describe('service integration', () => {
    it('should call updateDriveRole with correct parameters', async () => {
      vi.mocked(checkDriveAccessForRoles).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
      }));
      vi.mocked(getRoleById).mockResolvedValue(
        createRoleFixture({ id: mockRoleId, name: 'Original', driveId: mockDriveId })
      );
      vi.mocked(updateDriveRole).mockResolvedValue({
        role: createRoleFixture({ id: mockRoleId, name: 'Updated', driveId: mockDriveId }),
        wasDefault: false,
      });

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/${mockRoleId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: 'Updated',
          description: 'New description',
          color: '#ff0000',
          isDefault: true,
        }),
      });
      await PATCH(request, createContext(mockDriveId, mockRoleId));

      expect(updateDriveRole).toHaveBeenCalledWith(mockDriveId, mockRoleId, {
        name: 'Updated',
        description: 'New description',
        color: '#ff0000',
        isDefault: true,
        permissions: undefined,
      });
    });
  });

  describe('response contract', () => {
    it('should return 404 when role not found', async () => {
      vi.mocked(checkDriveAccessForRoles).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test', ownerId: mockUserId }),
      }));
      vi.mocked(getRoleById).mockResolvedValue(null);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/${mockRoleId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Updated' }),
      });
      const response = await PATCH(request, createContext(mockDriveId, mockRoleId));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Role not found');
    });

    it('should return updated role on success', async () => {
      const updatedRole = createRoleFixture({ id: mockRoleId, name: 'Updated', driveId: mockDriveId });

      vi.mocked(checkDriveAccessForRoles).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
      }));
      vi.mocked(getRoleById).mockResolvedValue(
        createRoleFixture({ id: mockRoleId, name: 'Original', driveId: mockDriveId })
      );
      vi.mocked(updateDriveRole).mockResolvedValue({ role: updatedRole, wasDefault: false });

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/${mockRoleId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Updated' }),
      });
      const response = await PATCH(request, createContext(mockDriveId, mockRoleId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.role.name).toBe('Updated');
    });
  });

  describe('error handling', () => {
    it('should return 409 for duplicate name', async () => {
      vi.mocked(checkDriveAccessForRoles).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
      }));
      vi.mocked(getRoleById).mockResolvedValue(
        createRoleFixture({ id: mockRoleId, name: 'Original', driveId: mockDriveId })
      );
      vi.mocked(updateDriveRole).mockRejectedValue(new Error('unique constraint'));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/${mockRoleId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Duplicate' }),
      });
      const response = await PATCH(request, createContext(mockDriveId, mockRoleId));
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body.error).toBe('A role with this name already exists');
    });

    it('should return 500 for other errors', async () => {
      vi.mocked(checkDriveAccessForRoles).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
      }));
      vi.mocked(getRoleById).mockResolvedValue(
        createRoleFixture({ id: mockRoleId, name: 'Original', driveId: mockDriveId })
      );
      vi.mocked(updateDriveRole).mockRejectedValue(new Error('Connection lost'));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/${mockRoleId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Updated' }),
      });
      const response = await PATCH(request, createContext(mockDriveId, mockRoleId));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to update role');
    });
  });
});

// ============================================================================
// DELETE /api/drives/[driveId]/roles/[roleId] - Contract Tests
// ============================================================================

describe('DELETE /api/drives/[driveId]/roles/[roleId]', () => {
  const mockUserId = 'user_123';
  const mockDriveId = 'drive_abc';
  const mockRoleId = 'role_xyz';

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/${mockRoleId}`, {
        method: 'DELETE',
      });
      const response = await DELETE(request, createContext(mockDriveId, mockRoleId));

      expect(response.status).toBe(401);
    });

    it('should require CSRF for delete operations', async () => {
      vi.mocked(checkDriveAccessForRoles).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
      }));
      vi.mocked(getRoleById).mockResolvedValue(
        createRoleFixture({ id: mockRoleId, name: 'ToDelete', driveId: mockDriveId })
      );
      vi.mocked(deleteDriveRole).mockResolvedValue(undefined);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/${mockRoleId}`, {
        method: 'DELETE',
      });
      await DELETE(request, createContext(mockDriveId, mockRoleId));

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['session'], requireCSRF: true }
      );
    });
  });

  describe('authorization', () => {
    it('should return 404 when drive not found', async () => {
      vi.mocked(checkDriveAccessForRoles).mockResolvedValue(createAccessFixture({ drive: null }));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/${mockRoleId}`, {
        method: 'DELETE',
      });
      const response = await DELETE(request, createContext(mockDriveId, mockRoleId));
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

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/${mockRoleId}`, {
        method: 'DELETE',
      });
      const response = await DELETE(request, createContext(mockDriveId, mockRoleId));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Only owners and admins can delete roles');
    });

    it('should allow admin to delete role', async () => {
      vi.mocked(checkDriveAccessForRoles).mockResolvedValue(createAccessFixture({
        isOwner: false,
        isAdmin: true,
        isMember: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Shared', ownerId: 'other_user' }),
      }));
      vi.mocked(getRoleById).mockResolvedValue(
        createRoleFixture({ id: mockRoleId, name: 'ToDelete', driveId: mockDriveId })
      );
      vi.mocked(deleteDriveRole).mockResolvedValue(undefined);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/${mockRoleId}`, {
        method: 'DELETE',
      });
      const response = await DELETE(request, createContext(mockDriveId, mockRoleId));

      expect(response.status).toBe(200);
    });
  });

  describe('service integration', () => {
    it('should call deleteDriveRole with driveId and roleId', async () => {
      vi.mocked(checkDriveAccessForRoles).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
      }));
      vi.mocked(getRoleById).mockResolvedValue(
        createRoleFixture({ id: mockRoleId, name: 'ToDelete', driveId: mockDriveId })
      );
      vi.mocked(deleteDriveRole).mockResolvedValue(undefined);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/${mockRoleId}`, {
        method: 'DELETE',
      });
      await DELETE(request, createContext(mockDriveId, mockRoleId));

      expect(deleteDriveRole).toHaveBeenCalledWith(mockDriveId, mockRoleId);
    });
  });

  describe('response contract', () => {
    it('should return 404 when role not found', async () => {
      vi.mocked(checkDriveAccessForRoles).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test', ownerId: mockUserId }),
      }));
      vi.mocked(getRoleById).mockResolvedValue(null);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/${mockRoleId}`, {
        method: 'DELETE',
      });
      const response = await DELETE(request, createContext(mockDriveId, mockRoleId));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Role not found');
    });

    it('should return success=true on successful deletion', async () => {
      vi.mocked(checkDriveAccessForRoles).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
      }));
      vi.mocked(getRoleById).mockResolvedValue(
        createRoleFixture({ id: mockRoleId, name: 'ToDelete', driveId: mockDriveId })
      );
      vi.mocked(deleteDriveRole).mockResolvedValue(undefined);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/${mockRoleId}`, {
        method: 'DELETE',
      });
      const response = await DELETE(request, createContext(mockDriveId, mockRoleId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should return 500 when delete fails', async () => {
      vi.mocked(checkDriveAccessForRoles).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
      }));
      vi.mocked(getRoleById).mockResolvedValue(
        createRoleFixture({ id: mockRoleId, name: 'ToDelete', driveId: mockDriveId })
      );
      vi.mocked(deleteDriveRole).mockRejectedValue(new Error('Delete failed'));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/${mockRoleId}`, {
        method: 'DELETE',
      });
      const response = await DELETE(request, createContext(mockDriveId, mockRoleId));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to delete role');
    });
  });
});
