/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ============================================================================
// Contract Tests for /api/storage/info
//
// Tests detailed storage information endpoint including file breakdowns.
// ============================================================================

const {
  mockSelectOrderBy,
  mockSelectWhere,
  mockSelectFrom,
  mockSelect,
} = vi.hoisted(() => ({
  mockSelectOrderBy: vi.fn().mockResolvedValue([]),
  mockSelectWhere: vi.fn(),
  mockSelectFrom: vi.fn(),
  mockSelect: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  verifyAuth: vi.fn(),
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
  withAdminAuth: vi.fn(),
}));

vi.mock('@pagespace/lib/services/storage-limits', () => ({
  getUserStorageQuota: vi.fn(),
  getUserFileCount: vi.fn(),
  reconcileStorageUsage: vi.fn(),
  STORAGE_TIERS: {
    free: {
      maxConcurrentUploads: 3,
      maxFileSizeBytes: 50 * 1024 * 1024,
      quotaBytes: 1024 * 1024 * 1024,
    },
  },
  formatBytes: vi.fn((bytes: number) => `${bytes} bytes`),
}));

vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      drives: {
        findMany: vi.fn(),
      },
    },
    select: mockSelect,
  },
  pages: {
    id: 'id',
    title: 'title',
    fileSize: 'fileSize',
    mimeType: 'mimeType',
    createdAt: 'createdAt',
    driveId: 'driveId',
    type: 'type',
    isTrashed: 'isTrashed',
  },
  drives: {
    ownerId: 'ownerId',
  },
  eq: vi.fn(),
  and: vi.fn(),
  desc: vi.fn(),
  inArray: vi.fn(),
}));

import { GET } from '../route';
import { verifyAuth } from '@/lib/auth';
import {
  getUserStorageQuota,
  getUserFileCount,
  reconcileStorageUsage,
} from '@pagespace/lib/services/storage-limits';
import { db } from '@pagespace/db';

// ============================================================================
// Test Helpers
// ============================================================================

const MOCK_USER = {
  id: 'user_123',
  role: 'user' as const,
  tokenVersion: 0,
  adminRoleVersion: 0,
  authTransport: 'cookie' as const,
};

const MOCK_QUOTA = {
  tier: 'free' as const,
  usedBytes: 100 * 1024 * 1024,
  quotaBytes: 1024 * 1024 * 1024,
  availableBytes: 924 * 1024 * 1024,
  percentUsed: 10,
};

// ============================================================================
// GET /api/storage/info - Contract Tests
// ============================================================================

describe('GET /api/storage/info', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(verifyAuth).mockResolvedValue(MOCK_USER as any);
    vi.mocked(getUserStorageQuota).mockResolvedValue(MOCK_QUOTA as any);
    vi.mocked(getUserFileCount).mockResolvedValue(5);
    vi.mocked(db.query.drives.findMany).mockResolvedValue([]);

    // Reset chain: db.select().from().where().orderBy()
    mockSelect.mockReturnValue({ from: mockSelectFrom });
    mockSelectFrom.mockReturnValue({ where: mockSelectWhere });
    mockSelectWhere.mockReturnValue({ orderBy: mockSelectOrderBy });
    mockSelectOrderBy.mockResolvedValue([]);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(verifyAuth).mockResolvedValue(null as any);

      const request = new Request('http://localhost/api/storage/info');
      const response = await GET(request as any);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Unauthorized');
    });
  });

  describe('reconciliation', () => {
    it('should reconcile storage when reconcile=true param is set', async () => {
      const request = new Request('http://localhost/api/storage/info?reconcile=true');
      await GET(request as any);

      expect(reconcileStorageUsage).toHaveBeenCalledWith('user_123');
    });

    it('should not reconcile when reconcile param is not set', async () => {
      const request = new Request('http://localhost/api/storage/info');
      await GET(request as any);

      expect(reconcileStorageUsage).not.toHaveBeenCalled();
    });

    it('should not fail if reconciliation throws', async () => {
      vi.mocked(reconcileStorageUsage).mockRejectedValue(new Error('Reconcile failed'));

      const request = new Request('http://localhost/api/storage/info?reconcile=true');
      const response = await GET(request as any);

      expect(response.status).toBe(200);
    });
  });

  describe('quota retrieval failure', () => {
    it('should return 500 when getUserStorageQuota returns null', async () => {
      vi.mocked(getUserStorageQuota).mockResolvedValue(null as any);

      const request = new Request('http://localhost/api/storage/info');
      const response = await GET(request as any);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Could not retrieve storage quota');
    });
  });

  describe('success - no drives', () => {
    it('should return empty file data when user has no drives', async () => {
      const request = new Request('http://localhost/api/storage/info');
      const response = await GET(request as any);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.quota).toBeDefined();
      expect(body.fileCount).toBe(5);
      expect(body.files).toEqual([]);
      expect(body.largestFiles).toEqual([]);
      expect(body.fileTypeBreakdown).toEqual({});
      expect(body.recentFiles).toEqual([]);
    });
  });

  describe('success - with drives and files', () => {
    it('should return file breakdown and storage by drive', async () => {
      vi.mocked(db.query.drives.findMany).mockResolvedValue([
        { id: 'drive_1', name: 'My Drive' },
      ] as any);
      mockSelectOrderBy.mockResolvedValue([
        { id: 'file_1', title: 'photo.jpg', fileSize: 1000, mimeType: 'image/jpeg', createdAt: new Date(), driveId: 'drive_1' },
        { id: 'file_2', title: 'doc.pdf', fileSize: 2000, mimeType: 'application/pdf', createdAt: new Date(), driveId: 'drive_1' },
      ]);

      const request = new Request('http://localhost/api/storage/info');
      const response = await GET(request as any);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.totalFiles).toBe(2);
      expect(body.fileTypeBreakdown).toBeDefined();
      expect(body.largestFiles).toHaveLength(2);
      expect(body.recentFiles).toHaveLength(2);
      expect(body.storageByDrive).toHaveLength(1);
      expect(body.storageByDrive[0].driveName).toBe('My Drive');
    });
  });

  describe('error handling', () => {
    it('should return 500 on unexpected error', async () => {
      vi.mocked(getUserStorageQuota).mockRejectedValue(new Error('DB error'));

      const request = new Request('http://localhost/api/storage/info');
      const response = await GET(request as any);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to get storage info');
    });
  });
});
