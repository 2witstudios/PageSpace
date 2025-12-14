/**
 * Contract tests for /api/pages/[pageId]/permissions
 *
 * These tests verify the route handler's contract:
 * - Request validation → appropriate error responses
 * - Service delegation → correct parameters passed
 * - Response mapping → service results mapped to HTTP responses
 * - Side effects → notifications with correct payload essentials
 */
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { NextResponse } from 'next/server';
import { GET, POST, DELETE } from '../route';
import type { WebAuthResult, AuthError } from '@/lib/auth';
import type {
  GetPermissionsResult,
  GrantPermissionResult,
  RevokePermissionResult,
  PermissionEntry,
} from '@/services/api';

// Mock service boundary - this is the ONLY mock of internal implementation
vi.mock('@/services/api', () => ({
  permissionManagementService: {
    canUserViewPermissions: vi.fn(),
    canUserManagePermissions: vi.fn(),
    getPagePermissions: vi.fn(),
    grantOrUpdatePermission: vi.fn(),
    revokePermission: vi.fn(),
  },
}));

// Mock external boundaries
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result) => 'error' in result),
}));

vi.mock('@pagespace/lib', () => ({
  createPermissionNotification: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  },
}));

import { permissionManagementService } from '@/services/api';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { createPermissionNotification } from '@pagespace/lib';

// Test helpers
const mockUserId = 'user_123';
const mockPageId = 'page_123';

const mockWebAuth = (userId: string): WebAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'jwt',
  source: 'cookie',
  role: 'user',
});

const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

const mockOwner = {
  id: 'owner_123',
  name: 'Owner',
  email: 'owner@example.com',
  image: null,
};

const mockPermission: PermissionEntry = {
  id: 'perm_123',
  userId: 'user_456',
  canView: true,
  canEdit: false,
  canShare: false,
  canDelete: false,
  grantedBy: 'owner_123',
  grantedAt: new Date(),
  user: {
    id: 'user_456',
    name: 'User',
    email: 'user@example.com',
    image: null,
  },
};

describe('GET /api/pages/[pageId]/permissions', () => {
  const createRequest = () => {
    return new Request(`https://example.com/api/pages/${mockPageId}/permissions`, {
      method: 'GET',
    });
  };

  const mockParams = Promise.resolve({ pageId: mockPageId });

  const successResult: GetPermissionsResult = {
    success: true,
    owner: mockOwner,
    permissions: [mockPermission],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (authenticateRequestWithOptions as Mock).mockResolvedValue(mockWebAuth(mockUserId));
    (permissionManagementService.canUserViewPermissions as Mock).mockResolvedValue(true);
    (permissionManagementService.getPagePermissions as Mock).mockResolvedValue(successResult);
  });

  describe('authentication', () => {
    it('returns 401 when user is not authenticated', async () => {
      (authenticateRequestWithOptions as Mock).mockResolvedValue(mockAuthError(401));

      const response = await GET(createRequest(), { params: mockParams });

      expect(response.status).toBe(401);
      expect(permissionManagementService.getPagePermissions).not.toHaveBeenCalled();
    });
  });

  describe('authorization', () => {
    it('returns 403 when user lacks share permission', async () => {
      (permissionManagementService.canUserViewPermissions as Mock).mockResolvedValue(false);

      const response = await GET(createRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toMatch(/share|permission/i);
      expect(permissionManagementService.getPagePermissions).not.toHaveBeenCalled();
    });
  });

  describe('permission retrieval', () => {
    it('returns 404 when page does not exist', async () => {
      (permissionManagementService.getPagePermissions as Mock).mockResolvedValue({
        success: false,
        error: 'Page not found',
        status: 404,
      });

      const response = await GET(createRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toMatch(/not found/i);
    });

    it('returns owner and permissions list on success', async () => {
      const response = await GET(createRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.owner).toBeDefined();
      expect(body.owner.id).toBe('owner_123');
      expect(body.permissions).toHaveLength(1);
    });

    it('returns empty permissions array when no permissions exist', async () => {
      (permissionManagementService.getPagePermissions as Mock).mockResolvedValue({
        success: true,
        owner: mockOwner,
        permissions: [],
      });

      const response = await GET(createRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.permissions).toHaveLength(0);
    });
  });

  describe('error handling', () => {
    it('returns 500 when service throws', async () => {
      (permissionManagementService.canUserViewPermissions as Mock).mockRejectedValue(new Error('Service error'));

      const response = await GET(createRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toMatch(/failed/i);
    });
  });
});

describe('POST /api/pages/[pageId]/permissions', () => {
  const createRequest = (body: Record<string, unknown>) => {
    return new Request(`https://example.com/api/pages/${mockPageId}/permissions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  };

  const mockParams = Promise.resolve({ pageId: mockPageId });

  const grantSuccessResult: GrantPermissionResult = {
    success: true,
    permission: mockPermission,
    isUpdate: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (authenticateRequestWithOptions as Mock).mockResolvedValue(mockWebAuth(mockUserId));
    (permissionManagementService.canUserManagePermissions as Mock).mockResolvedValue(true);
    (permissionManagementService.grantOrUpdatePermission as Mock).mockResolvedValue(grantSuccessResult);
  });

  describe('authentication', () => {
    it('returns 401 when user is not authenticated', async () => {
      (authenticateRequestWithOptions as Mock).mockResolvedValue(mockAuthError(401));

      const response = await POST(
        createRequest({ userId: 'user_456', canView: true }),
        { params: mockParams }
      );

      expect(response.status).toBe(401);
      expect(permissionManagementService.grantOrUpdatePermission).not.toHaveBeenCalled();
    });
  });

  describe('validation', () => {
    it('returns 400 when userId is missing', async () => {
      const response = await POST(
        createRequest({ canView: true }),
        { params: mockParams }
      );

      expect(response.status).toBe(400);
      expect(permissionManagementService.grantOrUpdatePermission).not.toHaveBeenCalled();
    });

    it('returns 400 when permission flags are invalid types', async () => {
      const response = await POST(
        createRequest({ userId: 'user_456', canView: 'yes' }),
        { params: mockParams }
      );

      expect(response.status).toBe(400);
      expect(permissionManagementService.grantOrUpdatePermission).not.toHaveBeenCalled();
    });
  });

  describe('authorization', () => {
    it('returns 403 when user cannot manage permissions', async () => {
      (permissionManagementService.canUserManagePermissions as Mock).mockResolvedValue(false);

      const response = await POST(
        createRequest({ userId: 'user_456', canView: true }),
        { params: mockParams }
      );
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toMatch(/permission|share/i);
      expect(permissionManagementService.grantOrUpdatePermission).not.toHaveBeenCalled();
    });
  });

  describe('service delegation', () => {
    it('passes correct parameters to service', async () => {
      await POST(
        createRequest({
          userId: 'user_456',
          canView: true,
          canEdit: true,
          canShare: false,
          canDelete: false,
        }),
        { params: mockParams }
      );

      expect(permissionManagementService.grantOrUpdatePermission).toHaveBeenCalledWith({
        pageId: mockPageId,
        targetUserId: 'user_456',
        permissions: {
          canView: true,
          canEdit: true,
          canShare: false,
          canDelete: false,
        },
        grantedBy: mockUserId,
      });
    });
  });

  describe('permission creation', () => {
    it('returns 201 when creating new permission', async () => {
      const response = await POST(
        createRequest({ userId: 'user_456', canView: true }),
        { params: mockParams }
      );

      expect(response.status).toBe(201);
    });

    it('returns 200 when updating existing permission', async () => {
      (permissionManagementService.grantOrUpdatePermission as Mock).mockResolvedValue({
        success: true,
        permission: mockPermission,
        isUpdate: true,
      });

      const response = await POST(
        createRequest({ userId: 'user_456', canView: true }),
        { params: mockParams }
      );

      expect(response.status).toBe(200);
    });
  });

  describe('side effects (notifications)', () => {
    it('sends granted notification for new permission', async () => {
      await POST(
        createRequest({
          userId: 'user_456',
          canView: true,
          canEdit: false,
          canShare: false,
          canDelete: false,
        }),
        { params: mockParams }
      );

      expect(createPermissionNotification).toHaveBeenCalledWith(
        'user_456',
        mockPageId,
        'granted',
        expect.objectContaining({ canView: true }),
        mockUserId
      );
    });

    it('sends updated notification when updating existing permission', async () => {
      (permissionManagementService.grantOrUpdatePermission as Mock).mockResolvedValue({
        success: true,
        permission: mockPermission,
        isUpdate: true,
      });

      await POST(
        createRequest({ userId: 'user_456', canView: true }),
        { params: mockParams }
      );

      expect(createPermissionNotification).toHaveBeenCalledWith(
        'user_456',
        mockPageId,
        'updated',
        expect.any(Object),
        mockUserId
      );
    });

    it('does NOT send notification when authorization fails', async () => {
      (permissionManagementService.canUserManagePermissions as Mock).mockResolvedValue(false);

      await POST(
        createRequest({ userId: 'user_456', canView: true }),
        { params: mockParams }
      );

      expect(createPermissionNotification).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('returns 500 when service throws', async () => {
      (permissionManagementService.grantOrUpdatePermission as Mock).mockRejectedValue(new Error('Service error'));

      const response = await POST(
        createRequest({ userId: 'user_456', canView: true }),
        { params: mockParams }
      );
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toMatch(/failed/i);
    });
  });
});

describe('DELETE /api/pages/[pageId]/permissions', () => {
  const createRequest = (body: Record<string, unknown>) => {
    return new Request(`https://example.com/api/pages/${mockPageId}/permissions`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  };

  const mockParams = Promise.resolve({ pageId: mockPageId });

  const revokeSuccessResult: RevokePermissionResult = {
    success: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (authenticateRequestWithOptions as Mock).mockResolvedValue(mockWebAuth(mockUserId));
    (permissionManagementService.canUserManagePermissions as Mock).mockResolvedValue(true);
    (permissionManagementService.revokePermission as Mock).mockResolvedValue(revokeSuccessResult);
  });

  describe('authentication', () => {
    it('returns 401 when user is not authenticated', async () => {
      (authenticateRequestWithOptions as Mock).mockResolvedValue(mockAuthError(401));

      const response = await DELETE(
        createRequest({ userId: 'user_456' }),
        { params: mockParams }
      );

      expect(response.status).toBe(401);
      expect(permissionManagementService.revokePermission).not.toHaveBeenCalled();
    });
  });

  describe('authorization', () => {
    it('returns 403 when user cannot manage permissions', async () => {
      (permissionManagementService.canUserManagePermissions as Mock).mockResolvedValue(false);

      const response = await DELETE(
        createRequest({ userId: 'user_456' }),
        { params: mockParams }
      );
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toMatch(/permission|manage/i);
      expect(permissionManagementService.revokePermission).not.toHaveBeenCalled();
    });
  });

  describe('service delegation', () => {
    it('passes correct parameters to service', async () => {
      await DELETE(
        createRequest({ userId: 'user_456' }),
        { params: mockParams }
      );

      expect(permissionManagementService.revokePermission).toHaveBeenCalledWith({
        pageId: mockPageId,
        targetUserId: 'user_456',
      });
    });
  });

  describe('permission deletion', () => {
    it('returns 200 with success on successful deletion', async () => {
      const response = await DELETE(
        createRequest({ userId: 'user_456' }),
        { params: mockParams }
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });
  });

  describe('side effects (notifications)', () => {
    it('sends revoked notification on successful deletion', async () => {
      await DELETE(
        createRequest({ userId: 'user_456' }),
        { params: mockParams }
      );

      expect(createPermissionNotification).toHaveBeenCalledWith(
        'user_456',
        mockPageId,
        'revoked',
        {},
        mockUserId
      );
    });

    it('does NOT send notification when authorization fails', async () => {
      (permissionManagementService.canUserManagePermissions as Mock).mockResolvedValue(false);

      await DELETE(
        createRequest({ userId: 'user_456' }),
        { params: mockParams }
      );

      expect(createPermissionNotification).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('returns 500 when service throws', async () => {
      (permissionManagementService.revokePermission as Mock).mockRejectedValue(new Error('Service error'));

      const response = await DELETE(
        createRequest({ userId: 'user_456' }),
        { params: mockParams }
      );
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toMatch(/failed/i);
    });
  });
});
