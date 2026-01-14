/**
 * EnforcedFileRepository Tests (P2-T7)
 *
 * Tests RBAC enforcement at the data access layer.
 * Ensures authorization cannot be bypassed by direct DB queries.
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

describe('EnforcedFileRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('ForbiddenError', () => {
    it('has correct status code (403)', () => {
      const error = new ForbiddenError('Access denied');
      expect(error.status).toBe(403);
      expect(error.name).toBe('ForbiddenError');
      expect(error.message).toBe('Access denied');
    });
  });

  describe('getFile', () => {
    it('returns file for authorized user with files:read scope', async () => {
      const claims = createMockClaims({
        scopes: ['files:read'],
        userRole: 'user',
      });
      const context = EnforcedAuthContext.fromSession(claims);
      const repo = new EnforcedFileRepository(context);

      const mockFile = createMockFile();
      vi.mocked(db.query.files.findFirst).mockResolvedValue(mockFile);
      vi.mocked(getUserDrivePermissions).mockResolvedValue({
        hasAccess: true,
        isOwner: false,
        isAdmin: false,
        isMember: true,
        canEdit: true,
      });

      const file = await repo.getFile('file-123');

      expect(file).toEqual(mockFile);
      expect(db.query.files.findFirst).toHaveBeenCalled();
      expect(getUserDrivePermissions).toHaveBeenCalledWith('user-123', 'drive-123');
    });

    it('returns null for non-existent file', async () => {
      const claims = createMockClaims({ scopes: ['files:read'] });
      const context = EnforcedAuthContext.fromSession(claims);
      const repo = new EnforcedFileRepository(context);

      vi.mocked(db.query.files.findFirst).mockResolvedValue(undefined);

      const file = await repo.getFile('non-existent');

      expect(file).toBeNull();
      // Should not check permissions for non-existent file
      expect(getUserDrivePermissions).not.toHaveBeenCalled();
    });

    it('throws ForbiddenError for non-member of drive', async () => {
      const claims = createMockClaims({ scopes: ['files:read'] });
      const context = EnforcedAuthContext.fromSession(claims);
      const repo = new EnforcedFileRepository(context);

      const mockFile = createMockFile();
      vi.mocked(db.query.files.findFirst).mockResolvedValue(mockFile);
      vi.mocked(getUserDrivePermissions).mockResolvedValue(null); // Not a member

      await expect(repo.getFile('file-123')).rejects.toThrow(ForbiddenError);
      await expect(repo.getFile('file-123')).rejects.toThrow('User not a member of this drive');
    });

    it('throws ForbiddenError for resource binding mismatch', async () => {
      const claims = createMockClaims({
        scopes: ['files:read'],
        resourceType: 'file',
        resourceId: 'different-file-id', // Bound to different file
      });
      const context = EnforcedAuthContext.fromSession(claims);
      const repo = new EnforcedFileRepository(context);

      const mockFile = createMockFile({ id: 'file-123' });
      vi.mocked(db.query.files.findFirst).mockResolvedValue(mockFile);

      await expect(repo.getFile('file-123')).rejects.toThrow(ForbiddenError);
      await expect(repo.getFile('file-123')).rejects.toThrow('Token not authorized for this resource');
    });

    it('throws ForbiddenError for missing files:read scope', async () => {
      const claims = createMockClaims({
        scopes: ['files:write'], // Has write but not read
      });
      const context = EnforcedAuthContext.fromSession(claims);
      const repo = new EnforcedFileRepository(context);

      const mockFile = createMockFile();
      vi.mocked(db.query.files.findFirst).mockResolvedValue(mockFile);
      vi.mocked(getUserDrivePermissions).mockResolvedValue({
        hasAccess: true,
        isOwner: false,
        isAdmin: false,
        isMember: true,
        canEdit: true,
      });

      await expect(repo.getFile('file-123')).rejects.toThrow(ForbiddenError);
      await expect(repo.getFile('file-123')).rejects.toThrow('Missing files:read scope');
    });

    it('admin bypasses drive membership check', async () => {
      const claims = createMockClaims({
        scopes: ['files:read'],
        userRole: 'admin',
      });
      const context = EnforcedAuthContext.fromSession(claims);
      const repo = new EnforcedFileRepository(context);

      const mockFile = createMockFile();
      vi.mocked(db.query.files.findFirst).mockResolvedValue(mockFile);
      // Not setting up getUserDrivePermissions - admin should bypass

      const file = await repo.getFile('file-123');

      expect(file).toEqual(mockFile);
      // Admin should not need membership check
      expect(getUserDrivePermissions).not.toHaveBeenCalled();
    });

    it('allows access when token is bound to drive containing the file', async () => {
      const claims = createMockClaims({
        scopes: ['files:read'],
        resourceType: 'drive',
        resourceId: 'drive-123', // Bound to the drive
      });
      const context = EnforcedAuthContext.fromSession(claims);
      const repo = new EnforcedFileRepository(context);

      const mockFile = createMockFile({ driveId: 'drive-123' });
      vi.mocked(db.query.files.findFirst).mockResolvedValue(mockFile);
      vi.mocked(getUserDrivePermissions).mockResolvedValue({
        hasAccess: true,
        isOwner: false,
        isAdmin: false,
        isMember: true,
        canEdit: true,
      });

      const file = await repo.getFile('file-123');

      expect(file).toEqual(mockFile);
    });
  });

  describe('updateFile', () => {
    it('updates file when user has files:write scope', async () => {
      const claims = createMockClaims({
        scopes: ['files:read', 'files:write'],
      });
      const context = EnforcedAuthContext.fromSession(claims);
      const repo = new EnforcedFileRepository(context);

      const mockFile = createMockFile();
      const updatedFile = { ...mockFile, mimeType: 'image/jpeg' };

      vi.mocked(db.query.files.findFirst).mockResolvedValue(mockFile);
      vi.mocked(getUserDrivePermissions).mockResolvedValue({
        hasAccess: true,
        isOwner: false,
        isAdmin: false,
        isMember: true,
        canEdit: true,
      });

      // Mock the update chain
      const mockReturning = vi.fn().mockResolvedValue([updatedFile]);
      const mockWhere = vi.fn().mockReturnValue({ returning: mockReturning });
      const mockSet = vi.fn().mockReturnValue({ where: mockWhere });
      vi.mocked(db.update).mockReturnValue({ set: mockSet } as any);

      const result = await repo.updateFile('file-123', { mimeType: 'image/jpeg' });

      expect(result).toEqual(updatedFile);
      expect(db.update).toHaveBeenCalled();
    });

    it('throws ForbiddenError when missing files:write scope', async () => {
      const claims = createMockClaims({
        scopes: ['files:read'], // Only read, no write
      });
      const context = EnforcedAuthContext.fromSession(claims);
      const repo = new EnforcedFileRepository(context);

      const mockFile = createMockFile();
      vi.mocked(db.query.files.findFirst).mockResolvedValue(mockFile);
      vi.mocked(getUserDrivePermissions).mockResolvedValue({
        hasAccess: true,
        isOwner: false,
        isAdmin: false,
        isMember: true,
        canEdit: true,
      });

      await expect(repo.updateFile('file-123', { mimeType: 'image/jpeg' })).rejects.toThrow(
        ForbiddenError
      );
      await expect(repo.updateFile('file-123', { mimeType: 'image/jpeg' })).rejects.toThrow(
        'Missing files:write scope'
      );
    });

    it('throws ForbiddenError when drive member has viewer role (canEdit=false)', async () => {
      const claims = createMockClaims({
        scopes: ['files:read', 'files:write'],
      });
      const context = EnforcedAuthContext.fromSession(claims);
      const repo = new EnforcedFileRepository(context);

      const mockFile = createMockFile();
      vi.mocked(db.query.files.findFirst).mockResolvedValue(mockFile);
      vi.mocked(getUserDrivePermissions).mockResolvedValue({
        hasAccess: true,
        isOwner: false,
        isAdmin: false,
        isMember: true,
        canEdit: false, // Viewer role
      });

      await expect(repo.updateFile('file-123', { mimeType: 'image/jpeg' })).rejects.toThrow(
        ForbiddenError
      );
      await expect(repo.updateFile('file-123', { mimeType: 'image/jpeg' })).rejects.toThrow(
        'Viewer role cannot modify files'
      );
    });

    it('throws ForbiddenError for non-existent file', async () => {
      const claims = createMockClaims({
        scopes: ['files:read', 'files:write'],
      });
      const context = EnforcedAuthContext.fromSession(claims);
      const repo = new EnforcedFileRepository(context);

      vi.mocked(db.query.files.findFirst).mockResolvedValue(undefined);

      await expect(repo.updateFile('non-existent', { mimeType: 'image/jpeg' })).rejects.toThrow(
        ForbiddenError
      );
      await expect(repo.updateFile('non-existent', { mimeType: 'image/jpeg' })).rejects.toThrow(
        'File not found'
      );
    });
  });
});
