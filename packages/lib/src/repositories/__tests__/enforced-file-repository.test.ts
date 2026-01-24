/**
 * EnforcedFileRepository Tests (P2-T7)
 *
 * Tests RBAC enforcement at the data access layer.
 * Ensures authorization cannot be bypassed by direct DB queries.
 *
 * SECURITY: Tests verify that unauthorized users cannot distinguish between
 * "file not found" and "file exists but unauthorized" to prevent ID enumeration.
 *
 * Following Eric Elliott's testing standards:
 * - Given/Should test naming structure
 * - Single assertion focus per test
 * - Isolated tests with clear setup
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EnforcedAuthContext } from '../../permissions/enforced-context';
import type { SessionClaims } from '../../auth/session-service';
import type { DrivePermissionLevel } from '../../permissions/permissions-cached';

// Mock @pagespace/db
vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      files: {
        findFirst: vi.fn(),
      },
      filePages: {
        findFirst: vi.fn(),
      },
    },
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(),
        })),
      })),
    })),
  },
  files: { id: 'id' },
  filePages: { fileId: 'fileId', pageId: 'pageId' },
  eq: vi.fn((a, b) => ({ type: 'eq', a, b })),
  and: vi.fn((...args) => ({ type: 'and', conditions: args })),
}));

// Mock permissions
vi.mock('../../permissions/permissions-cached', () => ({
  getUserDrivePermissions: vi.fn(),
}));

// Mock loggers
vi.mock('../../logging/logger-config', () => ({
  loggers: {
    api: {
      warn: vi.fn(),
      info: vi.fn(),
    },
  },
}));

// Import after mocks
import {
  EnforcedFileRepository,
  ForbiddenError,
  type FileRecord,
} from '../enforced-file-repository';
import { db } from '@pagespace/db';
import { getUserDrivePermissions } from '../../permissions/permissions-cached';

// Helper to create mock SessionClaims
const createMockClaims = (overrides: Partial<SessionClaims> = {}): SessionClaims => ({
  sessionId: 'test-session-id',
  userId: 'user-123',
  userRole: 'user',
  tokenVersion: 1,
  adminRoleVersion: 0,
  type: 'service',
  scopes: ['files:read'],
  expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1 hour
  driveId: undefined,
  ...overrides,
});

// Helper to create mock file record with proper typing
const createMockFile = (overrides: Partial<FileRecord> = {}): FileRecord => ({
  id: 'file-123',
  driveId: 'drive-123',
  sizeBytes: 1024,
  mimeType: 'image/png',
  storagePath: '/storage/abc123',
  checksumVersion: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
  createdBy: 'user-123',
  lastAccessedAt: null,
  ...overrides,
});

// Helper to create mock drive permissions with proper typing
const createMockDrivePermissions = (
  overrides: Partial<DrivePermissionLevel> = {}
): DrivePermissionLevel => ({
  hasAccess: true,
  isOwner: false,
  isAdmin: false,
  isMember: true,
  canEdit: true,
  ...overrides,
});

// Helper to mock db.update chain with proper type casting
// Uses unknown intermediate cast since mock structure differs from actual Drizzle types
const mockDbUpdate = (returnValue: FileRecord) => {
  const mockReturning = vi.fn().mockResolvedValue([returnValue]);
  const mockWhere = vi.fn().mockReturnValue({ returning: mockReturning });
  const mockSet = vi.fn().mockReturnValue({ where: mockWhere });
  vi.mocked(db.update).mockReturnValue({
    set: mockSet,
  } as unknown as ReturnType<typeof db.update>);
};

describe('EnforcedFileRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('ForbiddenError', () => {
    it('given a ForbiddenError, should have status 403', () => {
      const error = new ForbiddenError('Access denied');
      expect(error.status).toBe(403);
    });

    it('given a ForbiddenError, should have name "ForbiddenError"', () => {
      const error = new ForbiddenError('Access denied');
      expect(error.name).toBe('ForbiddenError');
    });

    it('given a ForbiddenError with message, should preserve the message', () => {
      const error = new ForbiddenError('Custom message');
      expect(error.message).toBe('Custom message');
    });
  });

  describe('getFile', () => {
    describe('given an authorized user with files:read scope and drive membership', () => {
      it('should return the file record', async () => {
        const claims = createMockClaims({ scopes: ['files:read'] });
        const context = EnforcedAuthContext.fromSession(claims);
        const repo = new EnforcedFileRepository(context);
        const mockFile = createMockFile();

        vi.mocked(db.query.files.findFirst).mockResolvedValue(mockFile);
        vi.mocked(getUserDrivePermissions).mockResolvedValue(createMockDrivePermissions());

        const file = await repo.getFile('file-123');

        expect(file).toEqual(mockFile);
      });

      it('should verify drive membership', async () => {
        const claims = createMockClaims({ scopes: ['files:read'] });
        const context = EnforcedAuthContext.fromSession(claims);
        const repo = new EnforcedFileRepository(context);

        vi.mocked(db.query.files.findFirst).mockResolvedValue(createMockFile());
        vi.mocked(getUserDrivePermissions).mockResolvedValue(createMockDrivePermissions());

        await repo.getFile('file-123');

        expect(getUserDrivePermissions).toHaveBeenCalledWith('user-123', 'drive-123');
      });
    });

    describe('given a non-existent file', () => {
      it('should return null', async () => {
        const claims = createMockClaims({ scopes: ['files:read'] });
        const context = EnforcedAuthContext.fromSession(claims);
        const repo = new EnforcedFileRepository(context);

        vi.mocked(db.query.files.findFirst).mockResolvedValue(undefined);

        const file = await repo.getFile('non-existent');

        expect(file).toBeNull();
      });

      it('should not check drive permissions', async () => {
        const claims = createMockClaims({ scopes: ['files:read'] });
        const context = EnforcedAuthContext.fromSession(claims);
        const repo = new EnforcedFileRepository(context);

        vi.mocked(db.query.files.findFirst).mockResolvedValue(undefined);

        await repo.getFile('non-existent');

        expect(getUserDrivePermissions).not.toHaveBeenCalled();
      });
    });

    // SECURITY: These tests verify null-masking to prevent enumeration attacks
    describe('given a user who is not a member of the drive (SECURITY: prevents enumeration)', () => {
      it('should return null instead of throwing (masks file existence)', async () => {
        const claims = createMockClaims({ scopes: ['files:read'] });
        const context = EnforcedAuthContext.fromSession(claims);
        const repo = new EnforcedFileRepository(context);

        vi.mocked(db.query.files.findFirst).mockResolvedValue(createMockFile());
        vi.mocked(getUserDrivePermissions).mockResolvedValue(null);

        const result = await repo.getFile('file-123');

        expect(result).toBeNull();
      });
    });

    describe('given a token bound to a different file (SECURITY: prevents enumeration)', () => {
      it('should return null instead of throwing (masks file existence)', async () => {
        const claims = createMockClaims({
          scopes: ['files:read'],
          resourceType: 'file',
          resourceId: 'different-file-id',
        });
        const context = EnforcedAuthContext.fromSession(claims);
        const repo = new EnforcedFileRepository(context);

        vi.mocked(db.query.files.findFirst).mockResolvedValue(createMockFile({ id: 'file-123' }));

        const result = await repo.getFile('file-123');

        expect(result).toBeNull();
      });
    });

    describe('given a user without files:read scope (SECURITY: prevents enumeration)', () => {
      it('should return null instead of throwing (masks file existence)', async () => {
        const claims = createMockClaims({ scopes: ['files:write'] });
        const context = EnforcedAuthContext.fromSession(claims);
        const repo = new EnforcedFileRepository(context);

        // Note: DB should not even be queried when scope is missing
        const result = await repo.getFile('file-123');

        expect(result).toBeNull();
      });

      it('should not query the database when scope is missing', async () => {
        const claims = createMockClaims({ scopes: ['files:write'] });
        const context = EnforcedAuthContext.fromSession(claims);
        const repo = new EnforcedFileRepository(context);

        await repo.getFile('file-123');

        expect(db.query.files.findFirst).not.toHaveBeenCalled();
      });
    });

    describe('given an admin user', () => {
      it('should return file without checking drive membership', async () => {
        const claims = createMockClaims({
          scopes: ['files:read'],
          userRole: 'admin',
        });
        const context = EnforcedAuthContext.fromSession(claims);
        const repo = new EnforcedFileRepository(context);
        const mockFile = createMockFile();

        vi.mocked(db.query.files.findFirst).mockResolvedValue(mockFile);

        const file = await repo.getFile('file-123');

        expect(file).toEqual(mockFile);
      });

      it('should bypass drive membership check', async () => {
        const claims = createMockClaims({
          scopes: ['files:read'],
          userRole: 'admin',
        });
        const context = EnforcedAuthContext.fromSession(claims);
        const repo = new EnforcedFileRepository(context);

        vi.mocked(db.query.files.findFirst).mockResolvedValue(createMockFile());

        await repo.getFile('file-123');

        expect(getUserDrivePermissions).not.toHaveBeenCalled();
      });
    });

    describe('given a token bound to the drive containing the file', () => {
      it('should allow access', async () => {
        const claims = createMockClaims({
          scopes: ['files:read'],
          resourceType: 'drive',
          resourceId: 'drive-123',
        });
        const context = EnforcedAuthContext.fromSession(claims);
        const repo = new EnforcedFileRepository(context);
        const mockFile = createMockFile({ driveId: 'drive-123' });

        vi.mocked(db.query.files.findFirst).mockResolvedValue(mockFile);
        vi.mocked(getUserDrivePermissions).mockResolvedValue(createMockDrivePermissions());

        const file = await repo.getFile('file-123');

        expect(file).toEqual(mockFile);
      });
    });

    describe('given a token bound to a page in the same drive as the file', () => {
      it('should allow access', async () => {
        const claims = createMockClaims({
          scopes: ['files:read'],
          resourceType: 'page',
          resourceId: 'page-123',
          driveId: 'drive-123',
        });
        const context = EnforcedAuthContext.fromSession(claims);
        const repo = new EnforcedFileRepository(context);
        const mockFile = createMockFile({ driveId: 'drive-123' });

        vi.mocked(db.query.files.findFirst).mockResolvedValue(mockFile);
        // Mock file-page link exists (file is linked to the bound page)
        vi.mocked(db.query.filePages.findFirst).mockResolvedValue({
          fileId: 'file-123',
          pageId: 'page-123',
          linkedBy: null,
          linkedAt: new Date(),
          linkSource: null,
        });
        vi.mocked(getUserDrivePermissions).mockResolvedValue(createMockDrivePermissions());

        const file = await repo.getFile('file-123');

        expect(file).toEqual(mockFile);
      });
    });

    describe('given a token bound to a page in a different drive (SECURITY: prevents cross-drive access)', () => {
      it('should return null instead of throwing (masks file existence)', async () => {
        const claims = createMockClaims({
          scopes: ['files:read'],
          resourceType: 'page',
          resourceId: 'page-in-other-drive',
          driveId: 'different-drive-456',
        });
        const context = EnforcedAuthContext.fromSession(claims);
        const repo = new EnforcedFileRepository(context);
        const mockFile = createMockFile({ driveId: 'drive-123' });

        vi.mocked(db.query.files.findFirst).mockResolvedValue(mockFile);
        // Mock no file-page link exists (file is NOT linked to this page)
        vi.mocked(db.query.filePages.findFirst).mockResolvedValue(undefined);

        const result = await repo.getFile('file-123');

        expect(result).toBeNull();
      });

      it('should not check drive permissions when resource binding fails', async () => {
        const claims = createMockClaims({
          scopes: ['files:read'],
          resourceType: 'page',
          resourceId: 'page-in-other-drive',
          driveId: 'different-drive-456',
        });
        const context = EnforcedAuthContext.fromSession(claims);
        const repo = new EnforcedFileRepository(context);
        const mockFile = createMockFile({ driveId: 'drive-123' });

        vi.mocked(db.query.files.findFirst).mockResolvedValue(mockFile);
        // Mock no file-page link exists (file is NOT linked to this page)
        vi.mocked(db.query.filePages.findFirst).mockResolvedValue(undefined);

        await repo.getFile('file-123');

        expect(getUserDrivePermissions).not.toHaveBeenCalled();
      });
    });

    describe('given a page-bound token without driveId (SECURITY: denies access)', () => {
      it('should return null when driveId is not set on context', async () => {
        const claims = createMockClaims({
          scopes: ['files:read'],
          resourceType: 'page',
          resourceId: 'page-123',
          driveId: undefined,
        });
        const context = EnforcedAuthContext.fromSession(claims);
        const repo = new EnforcedFileRepository(context);
        const mockFile = createMockFile({ driveId: 'drive-123' });

        vi.mocked(db.query.files.findFirst).mockResolvedValue(mockFile);
        // Mock no file-page link exists (file is NOT linked to this page)
        vi.mocked(db.query.filePages.findFirst).mockResolvedValue(undefined);

        const result = await repo.getFile('file-123');

        expect(result).toBeNull();
      });
    });
  });

  describe('updateFile', () => {
    describe('given a user with files:write scope and edit permission', () => {
      it('should return the updated file', async () => {
        const claims = createMockClaims({ scopes: ['files:read', 'files:write'] });
        const context = EnforcedAuthContext.fromSession(claims);
        const repo = new EnforcedFileRepository(context);
        const mockFile = createMockFile();
        const updatedFile = { ...mockFile, mimeType: 'image/jpeg' };

        vi.mocked(db.query.files.findFirst).mockResolvedValue(mockFile);
        vi.mocked(getUserDrivePermissions).mockResolvedValue(createMockDrivePermissions());
        mockDbUpdate(updatedFile);

        const result = await repo.updateFile('file-123', { mimeType: 'image/jpeg' });

        expect(result).toEqual(updatedFile);
      });

      it('should call db.update', async () => {
        const claims = createMockClaims({ scopes: ['files:read', 'files:write'] });
        const context = EnforcedAuthContext.fromSession(claims);
        const repo = new EnforcedFileRepository(context);
        const mockFile = createMockFile();

        vi.mocked(db.query.files.findFirst).mockResolvedValue(mockFile);
        vi.mocked(getUserDrivePermissions).mockResolvedValue(createMockDrivePermissions());
        mockDbUpdate(mockFile);

        await repo.updateFile('file-123', { mimeType: 'image/jpeg' });

        expect(db.update).toHaveBeenCalled();
      });
    });

    // SECURITY: These tests verify generic "Access denied" errors to prevent enumeration
    describe('given a user without files:write scope (SECURITY: generic error)', () => {
      it('should throw ForbiddenError with generic message', async () => {
        const claims = createMockClaims({ scopes: ['files:read'] });
        const context = EnforcedAuthContext.fromSession(claims);
        const repo = new EnforcedFileRepository(context);

        await expect(repo.updateFile('file-123', { mimeType: 'image/jpeg' })).rejects.toThrow(
          ForbiddenError
        );
      });

      it('should throw with "Access denied" message (not revealing specific reason)', async () => {
        const claims = createMockClaims({ scopes: ['files:read'] });
        const context = EnforcedAuthContext.fromSession(claims);
        const repo = new EnforcedFileRepository(context);

        await expect(repo.updateFile('file-123', { mimeType: 'image/jpeg' })).rejects.toThrow(
          'Access denied'
        );
      });
    });

    describe('given a user with viewer role (canEdit=false) (SECURITY: generic error)', () => {
      it('should throw ForbiddenError with generic message', async () => {
        const claims = createMockClaims({ scopes: ['files:read', 'files:write'] });
        const context = EnforcedAuthContext.fromSession(claims);
        const repo = new EnforcedFileRepository(context);

        vi.mocked(db.query.files.findFirst).mockResolvedValue(createMockFile());
        vi.mocked(getUserDrivePermissions).mockResolvedValue(
          createMockDrivePermissions({ canEdit: false })
        );

        await expect(repo.updateFile('file-123', { mimeType: 'image/jpeg' })).rejects.toThrow(
          ForbiddenError
        );
      });

      it('should throw with "Access denied" message (not revealing specific reason)', async () => {
        const claims = createMockClaims({ scopes: ['files:read', 'files:write'] });
        const context = EnforcedAuthContext.fromSession(claims);
        const repo = new EnforcedFileRepository(context);

        vi.mocked(db.query.files.findFirst).mockResolvedValue(createMockFile());
        vi.mocked(getUserDrivePermissions).mockResolvedValue(
          createMockDrivePermissions({ canEdit: false })
        );

        await expect(repo.updateFile('file-123', { mimeType: 'image/jpeg' })).rejects.toThrow(
          'Access denied'
        );
      });
    });

    describe('given a non-existent file (SECURITY: same error as unauthorized)', () => {
      it('should throw ForbiddenError (same as unauthorized to prevent enumeration)', async () => {
        const claims = createMockClaims({ scopes: ['files:read', 'files:write'] });
        const context = EnforcedAuthContext.fromSession(claims);
        const repo = new EnforcedFileRepository(context);

        vi.mocked(db.query.files.findFirst).mockResolvedValue(undefined);

        await expect(repo.updateFile('non-existent', { mimeType: 'image/jpeg' })).rejects.toThrow(
          ForbiddenError
        );
      });

      it('should throw with "Access denied" message (not "File not found")', async () => {
        const claims = createMockClaims({ scopes: ['files:read', 'files:write'] });
        const context = EnforcedAuthContext.fromSession(claims);
        const repo = new EnforcedFileRepository(context);

        vi.mocked(db.query.files.findFirst).mockResolvedValue(undefined);

        await expect(repo.updateFile('non-existent', { mimeType: 'image/jpeg' })).rejects.toThrow(
          'Access denied'
        );
      });
    });

    describe('given a user not in drive (SECURITY: same error as not found)', () => {
      it('should throw ForbiddenError with generic "Access denied"', async () => {
        const claims = createMockClaims({ scopes: ['files:read', 'files:write'] });
        const context = EnforcedAuthContext.fromSession(claims);
        const repo = new EnforcedFileRepository(context);

        vi.mocked(db.query.files.findFirst).mockResolvedValue(createMockFile());
        vi.mocked(getUserDrivePermissions).mockResolvedValue(null);

        await expect(repo.updateFile('file-123', { mimeType: 'image/jpeg' })).rejects.toThrow(
          'Access denied'
        );
      });
    });
  });
});
