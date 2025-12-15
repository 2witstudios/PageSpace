import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { GET, POST } from '../route';
import type { WebAuthResult, AuthError } from '@/lib/auth';
import type { DriveRoleAccessInfo, DriveRole, RolePermissions } from '@pagespace/lib/server';

// ============================================================================
// Contract Tests for /api/drives/[driveId]/roles
//
// These tests mock at the SERVICE SEAM level, NOT at the ORM/query-builder level.
// ============================================================================

vi.mock('@pagespace/lib/server', () => ({
  checkDriveAccessForRoles: vi.fn(),
  listDriveRoles: vi.fn(),
  createDriveRole: vi.fn(),
  validateRolePermissions: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

import {
  checkDriveAccessForRoles,
  listDriveRoles,
  createDriveRole,
  validateRolePermissions,
} from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

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

const createContext = (driveId: string) => ({
  params: Promise.resolve({ driveId }),
});

// ============================================================================
// GET /api/drives/[driveId]/roles - Contract Tests
// ============================================================================

describe('GET /api/drives/[driveId]/roles', () => {
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

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles`);
      const response = await GET(request, createContext(mockDriveId));

      expect(response.status).toBe(401);
    });

    it('should call authenticateRequestWithOptions with correct auth options', async () => {
      vi.mocked(checkDriveAccessForRoles).mockResolvedValue(createAccessFixture({
        isOwner: true,
        isMember: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
      }));
      vi.mocked(listDriveRoles).mockResolvedValue([]);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles`);
      await GET(request, createContext(mockDriveId));

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['jwt'], requireCSRF: false }
      );
    });
  });

  describe('authorization', () => {
    it('should return 404 when drive not found', async () => {
      vi.mocked(checkDriveAccessForRoles).mockResolvedValue(createAccessFixture({ drive: null }));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles`);
      const response = await GET(request, createContext(mockDriveId));
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

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles`);
      const response = await GET(request, createContext(mockDriveId));
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
      vi.mocked(listDriveRoles).mockResolvedValue([]);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles`);
      await GET(request, createContext(mockDriveId));

      expect(checkDriveAccessForRoles).toHaveBeenCalledWith(mockDriveId, mockUserId);
    });

    it('should call listDriveRoles with driveId', async () => {
      vi.mocked(checkDriveAccessForRoles).mockResolvedValue(createAccessFixture({
        isOwner: true,
        isMember: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
      }));
      vi.mocked(listDriveRoles).mockResolvedValue([]);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles`);
      await GET(request, createContext(mockDriveId));

      expect(listDriveRoles).toHaveBeenCalledWith(mockDriveId);
    });
  });

  describe('response contract', () => {
    it('should return empty roles array for drive with no roles', async () => {
      vi.mocked(checkDriveAccessForRoles).mockResolvedValue(createAccessFixture({
        isOwner: true,
        isMember: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test', ownerId: mockUserId }),
      }));
      vi.mocked(listDriveRoles).mockResolvedValue([]);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.roles).toEqual([]);
    });

    it('should return roles with all properties', async () => {
      const roles = [
        createRoleFixture({ id: 'role_1', name: 'Admin', driveId: mockDriveId, position: 0 }),
        createRoleFixture({ id: 'role_2', name: 'Editor', driveId: mockDriveId, position: 1 }),
      ];

      vi.mocked(checkDriveAccessForRoles).mockResolvedValue(createAccessFixture({
        isOwner: true,
        isMember: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
      }));
      vi.mocked(listDriveRoles).mockResolvedValue(roles);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.roles).toHaveLength(2);
      expect(body.roles[0].name).toBe('Admin');
      expect(body.roles[1].name).toBe('Editor');
    });

    it('should allow member to view roles', async () => {
      vi.mocked(checkDriveAccessForRoles).mockResolvedValue(createAccessFixture({
        isOwner: false,
        isMember: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Shared', ownerId: 'other_user' }),
      }));
      vi.mocked(listDriveRoles).mockResolvedValue([
        createRoleFixture({ id: 'role_1', name: 'Test Role', driveId: mockDriveId }),
      ]);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles`);
      const response = await GET(request, createContext(mockDriveId));

      expect(response.status).toBe(200);
    });
  });

  describe('error handling', () => {
    it('should return 500 when service throws', async () => {
      vi.mocked(checkDriveAccessForRoles).mockRejectedValue(new Error('Database error'));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch roles');
    });
  });
});

// ============================================================================
// POST /api/drives/[driveId]/roles - Contract Tests
// ============================================================================

describe('POST /api/drives/[driveId]/roles', () => {
  const mockUserId = 'user_123';
  const mockDriveId = 'drive_abc';

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

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles`, {
        method: 'POST',
        body: JSON.stringify({ name: 'New Role', permissions: {} }),
      });
      const response = await POST(request, createContext(mockDriveId));

      expect(response.status).toBe(401);
    });

    it('should require CSRF for write operations', async () => {
      vi.mocked(checkDriveAccessForRoles).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
      }));
      vi.mocked(createDriveRole).mockResolvedValue(
        createRoleFixture({ id: 'role_new', name: 'New', driveId: mockDriveId })
      );

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles`, {
        method: 'POST',
        body: JSON.stringify({ name: 'New', permissions: {} }),
      });
      await POST(request, createContext(mockDriveId));

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['jwt'], requireCSRF: true }
      );
    });
  });

  describe('authorization', () => {
    it('should return 404 when drive not found', async () => {
      vi.mocked(checkDriveAccessForRoles).mockResolvedValue(createAccessFixture({ drive: null }));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles`, {
        method: 'POST',
        body: JSON.stringify({ name: 'New Role', permissions: {} }),
      });
      const response = await POST(request, createContext(mockDriveId));
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

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles`, {
        method: 'POST',
        body: JSON.stringify({ name: 'New Role', permissions: {} }),
      });
      const response = await POST(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Only owners and admins can create roles');
    });

    it('should allow admin to create role', async () => {
      vi.mocked(checkDriveAccessForRoles).mockResolvedValue(createAccessFixture({
        isOwner: false,
        isAdmin: true,
        isMember: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Shared', ownerId: 'other_user' }),
      }));
      vi.mocked(createDriveRole).mockResolvedValue(
        createRoleFixture({ id: 'role_new', name: 'New', driveId: mockDriveId })
      );

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles`, {
        method: 'POST',
        body: JSON.stringify({ name: 'New', permissions: {} }),
      });
      const response = await POST(request, createContext(mockDriveId));

      expect(response.status).toBe(201);
    });
  });

  describe('validation', () => {
    beforeEach(() => {
      vi.mocked(checkDriveAccessForRoles).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test', ownerId: mockUserId }),
      }));
    });

    it('should reject request without name', async () => {
      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles`, {
        method: 'POST',
        body: JSON.stringify({ permissions: {} }),
      });
      const response = await POST(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Name and permissions are required');
    });

    it('should reject request without permissions', async () => {
      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Test Role' }),
      });
      const response = await POST(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Name and permissions are required');
    });

    it('should reject empty name', async () => {
      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles`, {
        method: 'POST',
        body: JSON.stringify({ name: '   ', permissions: {} }),
      });
      const response = await POST(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Role name must be between 1 and 50 characters');
    });

    it('should reject name longer than 50 characters', async () => {
      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles`, {
        method: 'POST',
        body: JSON.stringify({ name: 'a'.repeat(51), permissions: {} }),
      });
      const response = await POST(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Role name must be between 1 and 50 characters');
    });

    it('should reject invalid permissions structure', async () => {
      vi.mocked(validateRolePermissions).mockReturnValue(false);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Test', permissions: [] }),
      });
      const response = await POST(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid permissions structure');
    });
  });

  describe('service integration', () => {
    it('should call createDriveRole with correct parameters', async () => {
      vi.mocked(checkDriveAccessForRoles).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
      }));
      vi.mocked(createDriveRole).mockResolvedValue(
        createRoleFixture({ id: 'role_new', name: 'Editor', driveId: mockDriveId })
      );

      const permissions = { page_1: { canView: true, canEdit: true, canShare: false } };
      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Editor',
          description: 'Can edit pages',
          color: '#ff0000',
          isDefault: true,
          permissions,
        }),
      });
      await POST(request, createContext(mockDriveId));

      expect(createDriveRole).toHaveBeenCalledWith(mockDriveId, {
        name: 'Editor',
        description: 'Can edit pages',
        color: '#ff0000',
        isDefault: true,
        permissions,
      });
    });
  });

  describe('response contract', () => {
    it('should return 201 with role on successful creation', async () => {
      const newRole = createRoleFixture({ id: 'role_new', name: 'Editor', driveId: mockDriveId });

      vi.mocked(checkDriveAccessForRoles).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
      }));
      vi.mocked(createDriveRole).mockResolvedValue(newRole);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Editor', permissions: {} }),
      });
      const response = await POST(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(201);
      expect(body.role.name).toBe('Editor');
      expect(body.role.id).toBe('role_new');
    });
  });

  describe('error handling', () => {
    it('should return 409 for duplicate role name', async () => {
      vi.mocked(checkDriveAccessForRoles).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
      }));
      vi.mocked(createDriveRole).mockRejectedValue(new Error('unique constraint violation'));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Duplicate', permissions: {} }),
      });
      const response = await POST(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body.error).toBe('A role with this name already exists');
    });

    it('should return 500 for other database errors', async () => {
      vi.mocked(checkDriveAccessForRoles).mockResolvedValue(createAccessFixture({
        isOwner: true,
        drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
      }));
      vi.mocked(createDriveRole).mockRejectedValue(new Error('Connection lost'));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Test', permissions: {} }),
      });
      const response = await POST(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to create role');
    });
  });
});
