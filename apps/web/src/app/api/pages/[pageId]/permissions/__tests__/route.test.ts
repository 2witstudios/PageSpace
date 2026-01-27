/**
 * Contract tests for /api/pages/[pageId]/permissions
 *
 * These tests verify the route handler's contract:
 * - Request validation → appropriate error responses
 * - Zero-trust function delegation → correct parameters passed
 * - Response mapping → function results mapped to HTTP responses
 * - Side effects → notifications with correct payload essentials
 */
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { NextResponse } from 'next/server';
import { GET, POST, DELETE } from '../route';
import type { SessionAuthResult, AuthError, EnforcedAuthResult, EnforcedAuthError } from '@/lib/auth';
import type {
  GetPermissionsResult,
  PermissionEntry,
} from '@/services/api';
import type { GrantResult, RevokeResult } from '@pagespace/lib/server';

// Mock service boundary for GET (still uses permissionManagementService)
vi.mock('@/services/api', () => ({
  permissionManagementService: {
    canUserViewPermissions: vi.fn(),
    getPagePermissions: vi.fn(),
  },
}));

// Mock auth boundary - different auth for GET vs POST/DELETE
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  authenticateWithEnforcedContext: vi.fn(),
  isAuthError: vi.fn((result) => 'error' in result),
  isEnforcedAuthError: vi.fn((result) => 'error' in result),
}));

vi.mock('@pagespace/lib', () => ({
  createPermissionNotification: vi.fn(),
}));

// Mock zero-trust functions
vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  },
  grantPagePermission: vi.fn(),
  revokePagePermission: vi.fn(),
}));

vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      pages: {
        findFirst: vi.fn().mockResolvedValue({ driveId: 'drive_123', title: 'Test Page' }),
      },
    },
  },
  pages: { id: 'id' },
  eq: vi.fn(),
}));

// Mock websocket utilities for real-time permission revocation
vi.mock('@/lib/websocket', () => ({
  kickUserFromPage: vi.fn().mockResolvedValue({ success: true, kickedCount: 0, rooms: [] }),
  kickUserFromPageActivity: vi.fn().mockResolvedValue({ success: true, kickedCount: 0, rooms: [] }),
}));

import { permissionManagementService } from '@/services/api';
import { authenticateRequestWithOptions, authenticateWithEnforcedContext } from '@/lib/auth';
import { createPermissionNotification } from '@pagespace/lib';
import { grantPagePermission, revokePagePermission } from '@pagespace/lib/server';

// Test helpers
const mockUserId = 'cluser123456789012345';
const mockPageId = 'clpage123456789012345';
const mockTargetUserId = 'cltarget12345678901234';

const mockWebAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session-id',
  role: 'user',
  adminRoleVersion: 0,
});

const mockEnforcedAuth = (userId: string): EnforcedAuthResult => ({
  ctx: {
    userId,
    sessionId: 'test-session-id',
    userRole: 'user',
    tokenVersion: 0,
    adminRoleVersion: 0,
    scopes: ['*'],
  } as EnforcedAuthResult['ctx'],
});

const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

const mockEnforcedAuthError = (status = 401): EnforcedAuthError => ({
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
  userId: mockTargetUserId,
  canView: true,
  canEdit: false,
  canShare: false,
  canDelete: false,
  grantedBy: 'owner_123',
  grantedAt: new Date(),
  user: {
    id: mockTargetUserId,
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

  const grantSuccessResult: GrantResult = {
    ok: true,
    data: { permissionId: 'perm_123', isUpdate: false },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (authenticateWithEnforcedContext as Mock).mockResolvedValue(mockEnforcedAuth(mockUserId));
    (grantPagePermission as Mock).mockResolvedValue(grantSuccessResult);
  });

  describe('authentication', () => {
    it('returns 401 when user is not authenticated', async () => {
      (authenticateWithEnforcedContext as Mock).mockResolvedValue(mockEnforcedAuthError(401));

      const response = await POST(
        createRequest({ userId: mockTargetUserId, canView: true }),
        { params: mockParams }
      );

      expect(response.status).toBe(401);
      expect(grantPagePermission).not.toHaveBeenCalled();
    });
  });

  describe('validation', () => {
    it('returns 400 when userId is missing', async () => {
      const response = await POST(
        createRequest({ canView: true }),
        { params: mockParams }
      );

      expect(response.status).toBe(400);
    });

    it('returns 400 when permission flags are invalid types', async () => {
      const response = await POST(
        createRequest({ userId: mockTargetUserId, canView: 'yes' }),
        { params: mockParams }
      );

      expect(response.status).toBe(400);
    });
  });

  describe('authorization', () => {
    it('returns 403 when user cannot share page (PAGE_NOT_ACCESSIBLE)', async () => {
      (grantPagePermission as Mock).mockResolvedValue({
        ok: false,
        error: { code: 'PAGE_NOT_ACCESSIBLE', pageId: mockPageId },
      });

      const response = await POST(
        createRequest({ userId: mockTargetUserId, canView: true }),
        { params: mockParams }
      );
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toMatch(/permission|share/i);
    });
  });

  describe('zero-trust function delegation', () => {
    it('passes correct parameters to grantPagePermission', async () => {
      await POST(
        createRequest({
          userId: mockTargetUserId,
          canView: true,
          canEdit: true,
          canShare: false,
          canDelete: false,
        }),
        { params: mockParams }
      );

      expect(grantPagePermission).toHaveBeenCalledWith(
        expect.objectContaining({ userId: mockUserId }),
        expect.objectContaining({
          pageId: mockPageId,
          targetUserId: mockTargetUserId,
          permissions: {
            canView: true,
            canEdit: true,
            canShare: false,
            canDelete: false,
          },
        })
      );
    });
  });

  describe('permission creation', () => {
    it('returns 201 when creating new permission', async () => {
      const response = await POST(
        createRequest({ userId: mockTargetUserId, canView: true }),
        { params: mockParams }
      );

      expect(response.status).toBe(201);
    });

    it('returns 200 when updating existing permission', async () => {
      (grantPagePermission as Mock).mockResolvedValue({
        ok: true,
        data: { permissionId: 'perm_123', isUpdate: true },
      });

      const response = await POST(
        createRequest({ userId: mockTargetUserId, canView: true }),
        { params: mockParams }
      );

      expect(response.status).toBe(200);
    });
  });

  describe('side effects (notifications)', () => {
    it('sends granted notification for new permission', async () => {
      await POST(
        createRequest({
          userId: mockTargetUserId,
          canView: true,
          canEdit: false,
          canShare: false,
          canDelete: false,
        }),
        { params: mockParams }
      );

      expect(createPermissionNotification).toHaveBeenCalledWith(
        mockTargetUserId,
        mockPageId,
        'granted',
        expect.objectContaining({ canView: true }),
        mockUserId
      );
    });

    it('sends updated notification when updating existing permission', async () => {
      (grantPagePermission as Mock).mockResolvedValue({
        ok: true,
        data: { permissionId: 'perm_123', isUpdate: true },
      });

      await POST(
        createRequest({ userId: mockTargetUserId, canView: true }),
        { params: mockParams }
      );

      expect(createPermissionNotification).toHaveBeenCalledWith(
        mockTargetUserId,
        mockPageId,
        'updated',
        expect.any(Object),
        mockUserId
      );
    });

    it('does NOT send notification when authorization fails', async () => {
      (grantPagePermission as Mock).mockResolvedValue({
        ok: false,
        error: { code: 'PAGE_NOT_ACCESSIBLE', pageId: mockPageId },
      });

      await POST(
        createRequest({ userId: mockTargetUserId, canView: true }),
        { params: mockParams }
      );

      expect(createPermissionNotification).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('returns 404 when target user not found', async () => {
      (grantPagePermission as Mock).mockResolvedValue({
        ok: false,
        error: { code: 'USER_NOT_FOUND', userId: mockTargetUserId },
      });

      const response = await POST(
        createRequest({ userId: mockTargetUserId, canView: true }),
        { params: mockParams }
      );

      expect(response.status).toBe(404);
    });

    it('returns 500 when function throws', async () => {
      (grantPagePermission as Mock).mockRejectedValue(new Error('Service error'));

      const response = await POST(
        createRequest({ userId: mockTargetUserId, canView: true }),
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

  const revokeSuccessResult: RevokeResult = {
    ok: true,
    data: { revoked: true, permissionId: 'perm_123' },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (authenticateWithEnforcedContext as Mock).mockResolvedValue(mockEnforcedAuth(mockUserId));
    (revokePagePermission as Mock).mockResolvedValue(revokeSuccessResult);
  });

  describe('authentication', () => {
    it('returns 401 when user is not authenticated', async () => {
      (authenticateWithEnforcedContext as Mock).mockResolvedValue(mockEnforcedAuthError(401));

      const response = await DELETE(
        createRequest({ userId: mockTargetUserId }),
        { params: mockParams }
      );

      expect(response.status).toBe(401);
      expect(revokePagePermission).not.toHaveBeenCalled();
    });
  });

  describe('authorization', () => {
    it('returns 403 when user cannot manage page (PAGE_NOT_ACCESSIBLE)', async () => {
      (revokePagePermission as Mock).mockResolvedValue({
        ok: false,
        error: { code: 'PAGE_NOT_ACCESSIBLE', pageId: mockPageId },
      });

      const response = await DELETE(
        createRequest({ userId: mockTargetUserId }),
        { params: mockParams }
      );
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toMatch(/permission|manage/i);
    });
  });

  describe('zero-trust function delegation', () => {
    it('passes correct parameters to revokePagePermission', async () => {
      await DELETE(
        createRequest({ userId: mockTargetUserId }),
        { params: mockParams }
      );

      expect(revokePagePermission).toHaveBeenCalledWith(
        expect.objectContaining({ userId: mockUserId }),
        expect.objectContaining({
          pageId: mockPageId,
          targetUserId: mockTargetUserId,
        })
      );
    });
  });

  describe('permission deletion', () => {
    it('returns 200 with success on successful deletion', async () => {
      const response = await DELETE(
        createRequest({ userId: mockTargetUserId }),
        { params: mockParams }
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });

    it('returns 200 even when permission did not exist (idempotent)', async () => {
      (revokePagePermission as Mock).mockResolvedValue({
        ok: true,
        data: { revoked: false, reason: 'not_found' },
      });

      const response = await DELETE(
        createRequest({ userId: mockTargetUserId }),
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
        createRequest({ userId: mockTargetUserId }),
        { params: mockParams }
      );

      expect(createPermissionNotification).toHaveBeenCalledWith(
        mockTargetUserId,
        mockPageId,
        'revoked',
        {},
        mockUserId
      );
    });

    it('does NOT send notification when permission did not exist', async () => {
      (revokePagePermission as Mock).mockResolvedValue({
        ok: true,
        data: { revoked: false, reason: 'not_found' },
      });

      await DELETE(
        createRequest({ userId: mockTargetUserId }),
        { params: mockParams }
      );

      expect(createPermissionNotification).not.toHaveBeenCalled();
    });

    it('does NOT send notification when authorization fails', async () => {
      (revokePagePermission as Mock).mockResolvedValue({
        ok: false,
        error: { code: 'PAGE_NOT_ACCESSIBLE', pageId: mockPageId },
      });

      await DELETE(
        createRequest({ userId: mockTargetUserId }),
        { params: mockParams }
      );

      expect(createPermissionNotification).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('returns 500 when function throws', async () => {
      (revokePagePermission as Mock).mockRejectedValue(new Error('Service error'));

      const response = await DELETE(
        createRequest({ userId: mockTargetUserId }),
        { params: mockParams }
      );
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toMatch(/failed/i);
    });
  });
});
