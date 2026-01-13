import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createValidatedServiceToken,
  createPageServiceToken,
  createDriveServiceToken,
  createUserServiceToken,
  createUploadServiceToken,
  PermissionDeniedError,
  isPermissionDeniedError,
} from '../validated-service-token';

// Mock the database module
const mockFindFirst = vi.fn();
vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      pages: {
        findFirst: (...args: unknown[]) => mockFindFirst(...args),
      },
    },
  },
  pages: { id: 'pages.id' },
  eq: vi.fn((field: string, value: unknown) => ({ field, value })),
}));

// Mock the permissions module
vi.mock('../../permissions/permissions-cached', () => ({
  getUserAccessLevel: vi.fn(),
  getUserDrivePermissions: vi.fn(),
}));

// Mock the session service
const mockCreateSession = vi.fn().mockResolvedValue('ps_svc_mock-session-token');
vi.mock('../../auth/session-service', () => ({
  sessionService: {
    createSession: (...args: unknown[]) => mockCreateSession(...args),
  },
}));

// Mock the logger
vi.mock('../../logging/logger-config', () => ({
  loggers: {
    api: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  },
}));

import { getUserAccessLevel, getUserDrivePermissions } from '../../permissions/permissions-cached';
import { sessionService } from '../../auth/session-service';
import { loggers } from '../../logging/logger-config';

describe('createValidatedServiceToken', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('page resource type', () => {
    it('grants only scopes user actually has', async () => {
      // Arrange - user has view but not edit
      (getUserAccessLevel as ReturnType<typeof vi.fn>).mockResolvedValue({
        canView: true,
        canEdit: false,
        canShare: false,
        canDelete: false,
      });

      // Act
      const result = await createValidatedServiceToken({
        userId: 'user-1',
        resourceType: 'page',
        resourceId: 'page-1',
        requestedScopes: ['files:read', 'files:write'],
      });

      // Assert - only read scope granted
      expect(result.grantedScopes).toEqual(['files:read']);
      expect(mockCreateSession).toHaveBeenCalledWith(
        expect.objectContaining({
          scopes: ['files:read'],
        })
      );
    });

    it('throws when user has no access to resource', async () => {
      // Arrange - no access
      (getUserAccessLevel as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      // Act & Assert
      await expect(
        createValidatedServiceToken({
          userId: 'user-1',
          resourceType: 'page',
          resourceId: 'page-1',
          requestedScopes: ['files:read'],
        })
      ).rejects.toThrow('User has no access to page:page-1');

      expect(loggers.api.warn).toHaveBeenCalledWith(
        'Service token denied: no access to resource',
        expect.any(Object)
      );
    });

    it('throws when user lacks all requested scopes', async () => {
      // Arrange - user has view only
      (getUserAccessLevel as ReturnType<typeof vi.fn>).mockResolvedValue({
        canView: true,
        canEdit: false,
        canShare: false,
        canDelete: false,
      });

      // Act & Assert - request only write scope
      await expect(
        createValidatedServiceToken({
          userId: 'user-1',
          resourceType: 'page',
          resourceId: 'page-1',
          requestedScopes: ['files:write'],
        })
      ).rejects.toThrow('User lacks permissions for requested scopes: files:write');

      expect(loggers.api.warn).toHaveBeenCalledWith(
        'Service token denied: no authorized scopes',
        expect.any(Object)
      );
    });

    it('owner can request wildcard scope', async () => {
      // Arrange - owner has all permissions
      (getUserAccessLevel as ReturnType<typeof vi.fn>).mockResolvedValue({
        canView: true,
        canEdit: true,
        canShare: true,
        canDelete: true,
      });

      // Act
      const result = await createValidatedServiceToken({
        userId: 'user-1',
        resourceType: 'page',
        resourceId: 'page-1',
        requestedScopes: ['*'],
      });

      // Assert
      expect(result.grantedScopes).toEqual(['*']);
    });

    it('viewer cannot get write scope', async () => {
      // Arrange - viewer only
      (getUserAccessLevel as ReturnType<typeof vi.fn>).mockResolvedValue({
        canView: true,
        canEdit: false,
        canShare: false,
        canDelete: false,
      });

      // Act
      const result = await createValidatedServiceToken({
        userId: 'user-1',
        resourceType: 'page',
        resourceId: 'page-1',
        requestedScopes: ['files:read', 'files:write', 'files:delete'],
      });

      // Assert - only read granted
      expect(result.grantedScopes).toEqual(['files:read']);
    });

    it('editor cannot get delete scope', async () => {
      // Arrange - editor (view + edit, no delete)
      (getUserAccessLevel as ReturnType<typeof vi.fn>).mockResolvedValue({
        canView: true,
        canEdit: true,
        canShare: false,
        canDelete: false,
      });

      // Act
      const result = await createValidatedServiceToken({
        userId: 'user-1',
        resourceType: 'page',
        resourceId: 'page-1',
        requestedScopes: ['files:read', 'files:write', 'files:delete'],
      });

      // Assert - read and write granted, not delete
      expect(result.grantedScopes).toEqual(['files:read', 'files:write']);
    });

    it('logs scope grants for audit', async () => {
      // Arrange
      (getUserAccessLevel as ReturnType<typeof vi.fn>).mockResolvedValue({
        canView: true,
        canEdit: true,
        canShare: false,
        canDelete: false,
      });

      // Act
      await createValidatedServiceToken({
        userId: 'user-1',
        resourceType: 'page',
        resourceId: 'page-1',
        requestedScopes: ['files:read', 'files:write', 'files:delete'],
      });

      // Assert
      expect(loggers.api.info).toHaveBeenCalledWith(
        'Service token scope grant',
        expect.objectContaining({
          userId: 'user-1',
          resourceType: 'page',
          resourceId: 'page-1',
          requested: ['files:read', 'files:write', 'files:delete'],
          granted: ['files:read', 'files:write'],
          filtered: true,
        })
      );
    });
  });

  describe('drive resource type', () => {
    it('grants scopes when user is drive owner', async () => {
      // Arrange - user is drive owner
      (getUserDrivePermissions as ReturnType<typeof vi.fn>).mockResolvedValue({
        hasAccess: true,
        isOwner: true,
        isAdmin: false,
        isMember: false,
        canEdit: true,
      });

      // Act
      const result = await createValidatedServiceToken({
        userId: 'user-1',
        resourceType: 'drive',
        resourceId: 'drive-1',
        requestedScopes: ['files:read', 'files:write', '*'],
      });

      // Assert - all scopes granted including wildcard for owner
      expect(result.grantedScopes).toEqual(['files:read', 'files:write', '*']);
    });

    it('grants edit scopes when user is drive member', async () => {
      // Arrange - user is drive member (can edit)
      (getUserDrivePermissions as ReturnType<typeof vi.fn>).mockResolvedValue({
        hasAccess: true,
        isOwner: false,
        isAdmin: false,
        isMember: true,
        canEdit: true,
      });

      // Act
      const result = await createValidatedServiceToken({
        userId: 'user-1',
        resourceType: 'drive',
        resourceId: 'drive-1',
        requestedScopes: ['files:read', 'files:write'],
      });

      // Assert - read and write granted
      expect(result.grantedScopes).toEqual(['files:read', 'files:write']);
    });

    it('throws when user has no drive-level access', async () => {
      // Arrange - page collaborator returns null (no drive-level access)
      (getUserDrivePermissions as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      // Act & Assert
      await expect(
        createValidatedServiceToken({
          userId: 'user-1',
          resourceType: 'drive',
          resourceId: 'drive-1',
          requestedScopes: ['files:read'],
        })
      ).rejects.toThrow('User has no access to drive:drive-1');
    });

    it('does not grant owner scopes for non-owner drive access', async () => {
      // Arrange - has access but not owner (member)
      (getUserDrivePermissions as ReturnType<typeof vi.fn>).mockResolvedValue({
        hasAccess: true,
        isOwner: false,
        isAdmin: false,
        isMember: true,
        canEdit: true,
      });

      // Act
      const result = await createValidatedServiceToken({
        userId: 'user-1',
        resourceType: 'drive',
        resourceId: 'drive-1',
        requestedScopes: ['files:read', '*'],
      });

      // Assert - wildcard not granted (requires owner)
      expect(result.grantedScopes).toEqual(['files:read']);
    });

    it('admin can delete but not get wildcard scope', async () => {
      // Arrange - user is drive admin
      (getUserDrivePermissions as ReturnType<typeof vi.fn>).mockResolvedValue({
        hasAccess: true,
        isOwner: false,
        isAdmin: true,
        isMember: true,
        canEdit: true,
      });

      // Act
      const result = await createValidatedServiceToken({
        userId: 'user-1',
        resourceType: 'drive',
        resourceId: 'drive-1',
        requestedScopes: ['files:read', 'files:write', 'files:delete', '*'],
      });

      // Assert - delete granted (admin), but not wildcard (requires owner)
      expect(result.grantedScopes).toEqual(['files:read', 'files:write', 'files:delete']);
    });

    it('passes driveId claim when provided', async () => {
      // Arrange
      (getUserDrivePermissions as ReturnType<typeof vi.fn>).mockResolvedValue({
        hasAccess: true,
        isOwner: false,
        isAdmin: false,
        isMember: true,
        canEdit: true,
      });

      // Act
      await createValidatedServiceToken({
        userId: 'user-1',
        resourceType: 'drive',
        resourceId: 'drive-1',
        driveId: 'drive-1',
        requestedScopes: ['files:write'],
      });

      // Assert
      expect(mockCreateSession).toHaveBeenCalledWith(
        expect.objectContaining({
          driveId: 'drive-1',
        })
      );
    });
  });

  describe('user resource type', () => {
    it('grants all scopes for own user resources', async () => {
      // Act
      const result = await createValidatedServiceToken({
        userId: 'user-1',
        resourceType: 'user',
        resourceId: 'user-1', // Same as userId
        requestedScopes: ['avatars:write', '*'],
      });

      // Assert - all scopes granted for own resources
      expect(result.grantedScopes).toEqual(['avatars:write', '*']);
    });

    it('throws when accessing other user resources', async () => {
      // Act & Assert
      await expect(
        createValidatedServiceToken({
          userId: 'user-1',
          resourceType: 'user',
          resourceId: 'user-2', // Different from userId
          requestedScopes: ['avatars:write'],
        })
      ).rejects.toThrow('User has no access to user:user-2');
    });
  });

  describe('convenience functions', () => {
    it('createPageServiceToken creates page-scoped token', async () => {
      // Arrange
      (getUserAccessLevel as ReturnType<typeof vi.fn>).mockResolvedValue({
        canView: true,
        canEdit: true,
        canShare: false,
        canDelete: false,
      });

      // Act
      const result = await createPageServiceToken('user-1', 'page-1', ['files:read']);

      // Assert
      expect(result.grantedScopes).toEqual(['files:read']);
      expect(mockCreateSession).toHaveBeenCalledWith(
        expect.objectContaining({
          resourceId: 'page-1',
          resourceType: 'page',
        })
      );
    });

    it('createDriveServiceToken creates drive-scoped token', async () => {
      // Arrange
      (getUserDrivePermissions as ReturnType<typeof vi.fn>).mockResolvedValue({
        hasAccess: true,
        isOwner: false,
        isAdmin: false,
        isMember: true,
        canEdit: true,
      });

      // Act
      const result = await createDriveServiceToken('user-1', 'drive-1', ['files:write']);

      // Assert
      expect(result.grantedScopes).toEqual(['files:write']);
      expect(mockCreateSession).toHaveBeenCalledWith(
        expect.objectContaining({
          resourceId: 'drive-1',
          resourceType: 'drive',
          driveId: 'drive-1',
        })
      );
    });

    it('createUserServiceToken creates user-scoped token', async () => {
      // Act
      const result = await createUserServiceToken('user-1', ['avatars:write']);

      // Assert
      expect(result.grantedScopes).toEqual(['avatars:write']);
      expect(mockCreateSession).toHaveBeenCalledWith(
        expect.objectContaining({
          resourceId: 'user-1',
          resourceType: 'user',
          userId: 'user-1',
        })
      );
    });
  });

  describe('token options', () => {
    it('converts expiresIn to expiresInMs', async () => {
      // Arrange
      (getUserAccessLevel as ReturnType<typeof vi.fn>).mockResolvedValue({
        canView: true,
        canEdit: false,
        canShare: false,
        canDelete: false,
      });

      // Act
      await createValidatedServiceToken({
        userId: 'user-1',
        resourceType: 'page',
        resourceId: 'page-1',
        requestedScopes: ['files:read'],
        expiresIn: '10m',
      });

      // Assert - 10m = 600000ms
      expect(mockCreateSession).toHaveBeenCalledWith(
        expect.objectContaining({
          expiresInMs: 600000,
        })
      );
    });

    it('passes driveId when specified in options', async () => {
      // Arrange
      (getUserAccessLevel as ReturnType<typeof vi.fn>).mockResolvedValue({
        canView: true,
        canEdit: false,
        canShare: false,
        canDelete: false,
      });

      // Act
      await createValidatedServiceToken({
        userId: 'user-1',
        resourceType: 'page',
        resourceId: 'page-1',
        requestedScopes: ['files:read'],
        driveId: 'drive-1',
      });

      // Assert
      expect(mockCreateSession).toHaveBeenCalledWith(
        expect.objectContaining({
          driveId: 'drive-1',
        })
      );
    });
  });

  describe('createUploadServiceToken', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      mockFindFirst.mockClear();
    });

    it('grants token when user has page edit permission (parentId provided)', async () => {
      // Arrange - parent page exists in correct drive
      mockFindFirst.mockResolvedValue({ driveId: 'drive-1' });
      // User can edit parent page
      (getUserAccessLevel as ReturnType<typeof vi.fn>).mockResolvedValue({
        canView: true,
        canEdit: true,
        canShare: false,
        canDelete: false,
      });

      // Act
      const result = await createUploadServiceToken({
        userId: 'user-1',
        driveId: 'drive-1',
        pageId: 'new-page-1',
        parentId: 'parent-page-1',
      });

      // Assert
      expect(result.grantedScopes).toEqual(['files:write']);
      expect(result.token).toBe('ps_svc_mock-session-token');
      expect(mockFindFirst).toHaveBeenCalled();
      expect(getUserAccessLevel).toHaveBeenCalledWith('user-1', 'parent-page-1');
      expect(getUserDrivePermissions).not.toHaveBeenCalled();
      expect(mockCreateSession).toHaveBeenCalledWith(
        expect.objectContaining({
          resourceId: 'new-page-1',
          resourceType: 'page',
          driveId: 'drive-1',
          scopes: ['files:write'],
        })
      );
    });

    it('grants token when user has drive membership (no parentId)', async () => {
      // Arrange - user has drive edit permission
      (getUserDrivePermissions as ReturnType<typeof vi.fn>).mockResolvedValue({
        hasAccess: true,
        isOwner: false,
        isAdmin: false,
        isMember: true,
        canEdit: true,
      });

      // Act
      const result = await createUploadServiceToken({
        userId: 'user-1',
        driveId: 'drive-1',
        pageId: 'new-page-1',
      });

      // Assert
      expect(result.grantedScopes).toEqual(['files:write']);
      expect(result.token).toBe('ps_svc_mock-session-token');
      expect(getUserDrivePermissions).toHaveBeenCalledWith('user-1', 'drive-1');
      expect(getUserAccessLevel).not.toHaveBeenCalled();
      expect(mockCreateSession).toHaveBeenCalledWith(
        expect.objectContaining({
          resourceId: 'new-page-1',
          resourceType: 'page',
          driveId: 'drive-1',
          scopes: ['files:write'],
        })
      );
    });

    it('throws PermissionDeniedError when user lacks page edit permission', async () => {
      // Arrange - parent page exists in correct drive
      mockFindFirst.mockResolvedValue({ driveId: 'drive-1' });
      // User can view but not edit parent page
      (getUserAccessLevel as ReturnType<typeof vi.fn>).mockResolvedValue({
        canView: true,
        canEdit: false,
        canShare: false,
        canDelete: false,
      });

      // Act & Assert
      await expect(
        createUploadServiceToken({
          userId: 'user-1',
          driveId: 'drive-1',
          pageId: 'new-page-1',
          parentId: 'parent-page-1',
        })
      ).rejects.toThrow(PermissionDeniedError);

      expect(loggers.api.warn).toHaveBeenCalledWith(
        'Upload token denied: no permission',
        expect.objectContaining({
          userId: 'user-1',
          permissionSource: 'parent_page',
        })
      );
    });

    it('throws PermissionDeniedError when user lacks drive membership', async () => {
      // Arrange - no drive access
      (getUserDrivePermissions as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      // Act & Assert
      await expect(
        createUploadServiceToken({
          userId: 'user-1',
          driveId: 'drive-1',
          pageId: 'new-page-1',
        })
      ).rejects.toThrow(PermissionDeniedError);

      expect(loggers.api.warn).toHaveBeenCalledWith(
        'Upload token denied: no permission',
        expect.objectContaining({
          userId: 'user-1',
          permissionSource: 'drive',
        })
      );
    });

    it('throws PermissionDeniedError when parent page not found', async () => {
      // Arrange - parent page doesn't exist
      mockFindFirst.mockResolvedValue(null);

      // Act & Assert
      await expect(
        createUploadServiceToken({
          userId: 'user-1',
          driveId: 'drive-1',
          pageId: 'new-page-1',
          parentId: 'nonexistent-parent',
        })
      ).rejects.toThrow(PermissionDeniedError);

      expect(loggers.api.warn).toHaveBeenCalledWith(
        'Upload token denied: parent page not found',
        expect.objectContaining({
          userId: 'user-1',
          parentId: 'nonexistent-parent',
        })
      );
    });

    it('throws PermissionDeniedError when parent page drive mismatch (cross-drive attack)', async () => {
      // Arrange - parent page exists but in a different drive
      mockFindFirst.mockResolvedValue({ driveId: 'drive-a' });

      // Act & Assert - user claims drive-b but parent is from drive-a
      await expect(
        createUploadServiceToken({
          userId: 'user-1',
          driveId: 'drive-b',
          pageId: 'new-page-1',
          parentId: 'page-from-drive-a',
        })
      ).rejects.toThrow(PermissionDeniedError);

      expect(loggers.api.warn).toHaveBeenCalledWith(
        'Upload token denied: parent page drive mismatch',
        expect.objectContaining({
          userId: 'user-1',
          claimedDriveId: 'drive-b',
          actualDriveId: 'drive-a',
          parentId: 'page-from-drive-a',
        })
      );
    });

    it('throws PermissionDeniedError when user has no access to parent page', async () => {
      // Arrange - parent page exists in correct drive
      mockFindFirst.mockResolvedValue({ driveId: 'drive-1' });
      // But user has no access
      (getUserAccessLevel as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      // Act & Assert
      await expect(
        createUploadServiceToken({
          userId: 'user-1',
          driveId: 'drive-1',
          pageId: 'new-page-1',
          parentId: 'parent-page-1',
        })
      ).rejects.toThrow(PermissionDeniedError);

      expect(loggers.api.warn).toHaveBeenCalledWith(
        'Upload token denied: no permission',
        expect.objectContaining({
          userId: 'user-1',
          permissionSource: 'parent_page',
        })
      );
    });

    it('logs scope grant for audit', async () => {
      // Arrange
      (getUserDrivePermissions as ReturnType<typeof vi.fn>).mockResolvedValue({
        hasAccess: true,
        isOwner: false,
        isAdmin: false,
        isMember: true,
        canEdit: true,
      });

      // Act
      await createUploadServiceToken({
        userId: 'user-1',
        driveId: 'drive-1',
        pageId: 'new-page-1',
      });

      // Assert
      expect(loggers.api.info).toHaveBeenCalledWith(
        'Upload token scope grant',
        expect.objectContaining({
          userId: 'user-1',
          driveId: 'drive-1',
          pageId: 'new-page-1',
          permissionSource: 'drive',
          scopes: ['files:write'],
        })
      );
    });

    it('uses custom expiration when provided', async () => {
      // Arrange
      (getUserDrivePermissions as ReturnType<typeof vi.fn>).mockResolvedValue({
        hasAccess: true,
        isOwner: false,
        isAdmin: false,
        isMember: true,
        canEdit: true,
      });

      // Act
      await createUploadServiceToken({
        userId: 'user-1',
        driveId: 'drive-1',
        pageId: 'new-page-1',
        expiresIn: '15m',
      });

      // Assert - 15m = 900000ms
      expect(mockCreateSession).toHaveBeenCalledWith(
        expect.objectContaining({
          expiresInMs: 900000,
        })
      );
    });

    it('uses default 10m expiration when not provided', async () => {
      // Arrange
      (getUserDrivePermissions as ReturnType<typeof vi.fn>).mockResolvedValue({
        hasAccess: true,
        isOwner: false,
        isAdmin: false,
        isMember: true,
        canEdit: true,
      });

      // Act
      await createUploadServiceToken({
        userId: 'user-1',
        driveId: 'drive-1',
        pageId: 'new-page-1',
      });

      // Assert - 10m = 600000ms
      expect(mockCreateSession).toHaveBeenCalledWith(
        expect.objectContaining({
          expiresInMs: 600000,
        })
      );
    });

    it('bubbles token signing errors (not PermissionDeniedError)', async () => {
      // Arrange - user has permission
      (getUserDrivePermissions as ReturnType<typeof vi.fn>).mockResolvedValue({
        hasAccess: true,
        isOwner: false,
        isAdmin: false,
        isMember: true,
        canEdit: true,
      });
      // But token signing fails
      const signingError = new Error('Token signing failed');
      (mockCreateSession as ReturnType<typeof vi.fn>).mockRejectedValue(
        signingError
      );

      // Act - capture the error
      let caughtError: unknown;
      try {
        await createUploadServiceToken({
          userId: 'user-1',
          driveId: 'drive-1',
          pageId: 'new-page-1',
        });
      } catch (error) {
        caughtError = error;
      }

      // Assert - error should bubble up as regular Error, not PermissionDeniedError
      expect(caughtError).toBeInstanceOf(Error);
      expect(caughtError).not.toBeInstanceOf(PermissionDeniedError);
      expect(isPermissionDeniedError(caughtError)).toBe(false);
      expect((caughtError as Error).message).toBe('Token signing failed');
    });
  });

  describe('isPermissionDeniedError', () => {
    it('returns true for PermissionDeniedError instances', () => {
      const error = new PermissionDeniedError('test error');
      expect(isPermissionDeniedError(error)).toBe(true);
    });

    it('returns false for regular Error instances', () => {
      const error = new Error('test error');
      expect(isPermissionDeniedError(error)).toBe(false);
    });

    it('returns false for non-Error values', () => {
      expect(isPermissionDeniedError(null)).toBe(false);
      expect(isPermissionDeniedError(undefined)).toBe(false);
      expect(isPermissionDeniedError('string error')).toBe(false);
      expect(isPermissionDeniedError({ message: 'object' })).toBe(false);
    });

    it('returns false for Error with wrong code', () => {
      const error = new Error('test') as Error & { code: string };
      error.code = 'OTHER_ERROR';
      expect(isPermissionDeniedError(error)).toBe(false);
    });
  });
});
