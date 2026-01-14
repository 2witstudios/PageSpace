/**
 * EnforcedFileRepository Tests (P2-T7)
 *
 * Tests RBAC enforcement at the data access layer.
 * Ensures authorization cannot be bypassed by direct DB queries.
 *
 * Following Eric Elliott's testing standards:
 * - Given/Should test naming structure
 * - Single assertion focus per test
 * - Isolated tests with clear setup
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EnforcedAuthContext } from '../../permissions/enforced-context';
import type { SessionClaims } from '../../auth/session-service';

// Mock @pagespace/db
vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      files: {
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
  eq: vi.fn((a, b) => ({ type: 'eq', a, b })),
}));

// Mock permissions
vi.mock('../../permissions/permissions-cached', () => ({
  getUserDrivePermissions: vi.fn(),
}));

// Import after mocks
import { EnforcedFileRepository, ForbiddenError } from '../enforced-file-repository';
import { db } from '@pagespace/db';
import { getUserDrivePermissions } from '../../permissions/permissions-cached';

// Helper to create mock SessionClaims
const createMockClaims = (overrides: Partial<SessionClaims> = {}): SessionClaims => ({
  sessionId: 'test-session-id',
  userId: 'user-123',
  userRole: 'user',
  tokenVersion: 1,
  type: 'service',
  scopes: ['files:read'],
  driveId: undefined,
  ...overrides,
});

// Helper to create mock file record
const createMockFile = (overrides: Record<string, unknown> = {}) => ({
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

// Helper to create mock drive permissions
const createMockDrivePermissions = (overrides: Record<string, unknown> = {}) => ({
  hasAccess: true,
  isOwner: false,
  isAdmin: false,
  isMember: true,
  canEdit: true,
  ...overrides,
});

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

    describe('given a user who is not a member of the drive', () => {
      it('should throw ForbiddenError', async () => {
        const claims = createMockClaims({ scopes: ['files:read'] });
        const context = EnforcedAuthContext.fromSession(claims);
        const repo = new EnforcedFileRepository(context);

        vi.mocked(db.query.files.findFirst).mockResolvedValue(createMockFile());
        vi.mocked(getUserDrivePermissions).mockResolvedValue(null);

        await expect(repo.getFile('file-123')).rejects.toThrow(ForbiddenError);
      });

      it('should throw with "User not a member of this drive" message', async () => {
        const claims = createMockClaims({ scopes: ['files:read'] });
        const context = EnforcedAuthContext.fromSession(claims);
        const repo = new EnforcedFileRepository(context);

        vi.mocked(db.query.files.findFirst).mockResolvedValue(createMockFile());
        vi.mocked(getUserDrivePermissions).mockResolvedValue(null);

        await expect(repo.getFile('file-123')).rejects.toThrow('User not a member of this drive');
      });
    });

    describe('given a token bound to a different file', () => {
      it('should throw ForbiddenError', async () => {
        const claims = createMockClaims({
          scopes: ['files:read'],
          resourceType: 'file',
          resourceId: 'different-file-id',
        });
        const context = EnforcedAuthContext.fromSession(claims);
        const repo = new EnforcedFileRepository(context);

        vi.mocked(db.query.files.findFirst).mockResolvedValue(createMockFile({ id: 'file-123' }));

        await expect(repo.getFile('file-123')).rejects.toThrow(ForbiddenError);
      });

      it('should throw with "Token not authorized for this resource" message', async () => {
        const claims = createMockClaims({
          scopes: ['files:read'],
          resourceType: 'file',
          resourceId: 'different-file-id',
        });
        const context = EnforcedAuthContext.fromSession(claims);
        const repo = new EnforcedFileRepository(context);

        vi.mocked(db.query.files.findFirst).mockResolvedValue(createMockFile({ id: 'file-123' }));

        await expect(repo.getFile('file-123')).rejects.toThrow(
          'Token not authorized for this resource'
        );
      });
    });

    describe('given a user without files:read scope', () => {
      it('should throw ForbiddenError', async () => {
        const claims = createMockClaims({ scopes: ['files:write'] });
        const context = EnforcedAuthContext.fromSession(claims);
        const repo = new EnforcedFileRepository(context);

        vi.mocked(db.query.files.findFirst).mockResolvedValue(createMockFile());
        vi.mocked(getUserDrivePermissions).mockResolvedValue(createMockDrivePermissions());

        await expect(repo.getFile('file-123')).rejects.toThrow(ForbiddenError);
      });

      it('should throw with "Missing files:read scope" message', async () => {
        const claims = createMockClaims({ scopes: ['files:write'] });
        const context = EnforcedAuthContext.fromSession(claims);
        const repo = new EnforcedFileRepository(context);

        vi.mocked(db.query.files.findFirst).mockResolvedValue(createMockFile());
        vi.mocked(getUserDrivePermissions).mockResolvedValue(createMockDrivePermissions());

        await expect(repo.getFile('file-123')).rejects.toThrow('Missing files:read scope');
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

        const mockReturning = vi.fn().mockResolvedValue([updatedFile]);
        const mockWhere = vi.fn().mockReturnValue({ returning: mockReturning });
        const mockSet = vi.fn().mockReturnValue({ where: mockWhere });
        vi.mocked(db.update).mockReturnValue({ set: mockSet } as any);

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

        const mockReturning = vi.fn().mockResolvedValue([mockFile]);
        const mockWhere = vi.fn().mockReturnValue({ returning: mockReturning });
        const mockSet = vi.fn().mockReturnValue({ where: mockWhere });
        vi.mocked(db.update).mockReturnValue({ set: mockSet } as any);

        await repo.updateFile('file-123', { mimeType: 'image/jpeg' });

        expect(db.update).toHaveBeenCalled();
      });
    });

    describe('given a user without files:write scope', () => {
      it('should throw ForbiddenError', async () => {
        const claims = createMockClaims({ scopes: ['files:read'] });
        const context = EnforcedAuthContext.fromSession(claims);
        const repo = new EnforcedFileRepository(context);

        vi.mocked(db.query.files.findFirst).mockResolvedValue(createMockFile());
        vi.mocked(getUserDrivePermissions).mockResolvedValue(createMockDrivePermissions());

        await expect(repo.updateFile('file-123', { mimeType: 'image/jpeg' })).rejects.toThrow(
          ForbiddenError
        );
      });

      it('should throw with "Missing files:write scope" message', async () => {
        const claims = createMockClaims({ scopes: ['files:read'] });
        const context = EnforcedAuthContext.fromSession(claims);
        const repo = new EnforcedFileRepository(context);

        vi.mocked(db.query.files.findFirst).mockResolvedValue(createMockFile());
        vi.mocked(getUserDrivePermissions).mockResolvedValue(createMockDrivePermissions());

        await expect(repo.updateFile('file-123', { mimeType: 'image/jpeg' })).rejects.toThrow(
          'Missing files:write scope'
        );
      });
    });

    describe('given a user with viewer role (canEdit=false)', () => {
      it('should throw ForbiddenError', async () => {
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

      it('should throw with "Viewer role cannot modify files" message', async () => {
        const claims = createMockClaims({ scopes: ['files:read', 'files:write'] });
        const context = EnforcedAuthContext.fromSession(claims);
        const repo = new EnforcedFileRepository(context);

        vi.mocked(db.query.files.findFirst).mockResolvedValue(createMockFile());
        vi.mocked(getUserDrivePermissions).mockResolvedValue(
          createMockDrivePermissions({ canEdit: false })
        );

        await expect(repo.updateFile('file-123', { mimeType: 'image/jpeg' })).rejects.toThrow(
          'Viewer role cannot modify files'
        );
      });
    });

    describe('given a non-existent file', () => {
      it('should throw ForbiddenError', async () => {
        const claims = createMockClaims({ scopes: ['files:read', 'files:write'] });
        const context = EnforcedAuthContext.fromSession(claims);
        const repo = new EnforcedFileRepository(context);

        vi.mocked(db.query.files.findFirst).mockResolvedValue(undefined);

        await expect(repo.updateFile('non-existent', { mimeType: 'image/jpeg' })).rejects.toThrow(
          ForbiddenError
        );
      });

      it('should throw with "File not found" message', async () => {
        const claims = createMockClaims({ scopes: ['files:read', 'files:write'] });
        const context = EnforcedAuthContext.fromSession(claims);
        const repo = new EnforcedFileRepository(context);

        vi.mocked(db.query.files.findFirst).mockResolvedValue(undefined);

        await expect(repo.updateFile('non-existent', { mimeType: 'image/jpeg' })).rejects.toThrow(
          'File not found'
        );
      });
    });
  });
});
