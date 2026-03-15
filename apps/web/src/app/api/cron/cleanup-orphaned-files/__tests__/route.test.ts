/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';

// ============================================================================
// Contract Tests for /api/cron/cleanup-orphaned-files
//
// Tests detection and cleanup of orphaned files (zero references).
// ============================================================================

vi.mock('@/lib/auth/cron-auth', () => ({
  validateSignedCronRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/compliance/file-cleanup/orphan-detector', () => ({
  findOrphanedFileRecords: vi.fn(),
  deleteFileRecords: vi.fn(),
}));

vi.mock('@pagespace/db', () => ({
  db: {},
}));

vi.mock('@pagespace/lib', () => ({
  createDriveServiceToken: vi.fn(),
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { GET, POST } from '../route';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';
import { findOrphanedFileRecords, deleteFileRecords } from '@pagespace/lib/compliance/file-cleanup/orphan-detector';
import { createDriveServiceToken } from '@pagespace/lib';

// ============================================================================
// Fixtures
// ============================================================================

const ORPHAN_WITH_PATH = {
  id: 'file_1',
  driveId: 'drive_1',
  storagePath: '/storage/abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890/original',
};

const ORPHAN_WITHOUT_PATH = {
  id: 'file_2',
  driveId: 'drive_2',
  storagePath: null,
};

const ORPHAN_WITH_MALFORMED_PATH = {
  id: 'file_3',
  driveId: 'drive_3',
  storagePath: '/storage/not-a-hash/original',
};

// ============================================================================
// GET /api/cron/cleanup-orphaned-files - Contract Tests
// ============================================================================

describe('GET /api/cron/cleanup-orphaned-files', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateSignedCronRequest).mockReturnValue(null);
    vi.mocked(createDriveServiceToken).mockResolvedValue({ token: 'test-token' } as any);
    mockFetch.mockResolvedValue({ ok: true });
  });

  describe('authentication', () => {
    it('should return auth error when cron request is invalid', async () => {
      const errorResponse = NextResponse.json(
        { error: 'Forbidden' },
        { status: 403 }
      );
      vi.mocked(validateSignedCronRequest).mockReturnValue(errorResponse);

      const request = new Request('http://localhost/api/cron/cleanup-orphaned-files');
      const response = await GET(request);

      expect(response.status).toBe(403);
    });
  });

  describe('success - no orphans', () => {
    it('should return success with 0 counts when no orphans found', async () => {
      vi.mocked(findOrphanedFileRecords).mockResolvedValue([]);

      const request = new Request('http://localhost/api/cron/cleanup-orphaned-files');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.orphansFound).toBe(0);
      expect(body.filesDeleted).toBe(0);
      expect(body.physicalFilesDeleted).toBe(0);
      expect(body.timestamp).toBeDefined();
    });
  });

  describe('success - with orphans', () => {
    it('should delete physical files and DB records for orphans with valid storage paths', async () => {
      vi.mocked(findOrphanedFileRecords).mockResolvedValue([ORPHAN_WITH_PATH]);
      vi.mocked(deleteFileRecords).mockResolvedValue(1);

      const request = new Request('http://localhost/api/cron/cleanup-orphaned-files');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.orphansFound).toBe(1);
      expect(body.physicalFilesDeleted).toBe(1);
      expect(body.filesDeleted).toBe(1);
      expect(body.failedPhysicalDeletes).toBeUndefined();
    });

    it('should skip physical delete for orphans without storagePath', async () => {
      vi.mocked(findOrphanedFileRecords).mockResolvedValue([ORPHAN_WITHOUT_PATH]);
      vi.mocked(deleteFileRecords).mockResolvedValue(1);

      const request = new Request('http://localhost/api/cron/cleanup-orphaned-files');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.orphansFound).toBe(1);
      expect(body.physicalFilesDeleted).toBe(0);
      expect(body.filesDeleted).toBe(1);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should record failed physical deletes for malformed storage paths', async () => {
      vi.mocked(findOrphanedFileRecords).mockResolvedValue([ORPHAN_WITH_MALFORMED_PATH]);
      vi.mocked(deleteFileRecords).mockResolvedValue(1);

      const request = new Request('http://localhost/api/cron/cleanup-orphaned-files');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.orphansFound).toBe(1);
      expect(body.physicalFilesDeleted).toBe(0);
      expect(body.failedPhysicalDeletes).toContain('file_3');
    });

    it('should record failed physical deletes when processor returns non-ok response', async () => {
      vi.mocked(findOrphanedFileRecords).mockResolvedValue([ORPHAN_WITH_PATH]);
      vi.mocked(deleteFileRecords).mockResolvedValue(1);
      mockFetch.mockResolvedValue({ ok: false, status: 500 });

      const request = new Request('http://localhost/api/cron/cleanup-orphaned-files');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.physicalFilesDeleted).toBe(0);
      expect(body.failedPhysicalDeletes).toContain('file_1');
    });

    it('should record failed physical deletes when fetch throws', async () => {
      vi.mocked(findOrphanedFileRecords).mockResolvedValue([ORPHAN_WITH_PATH]);
      vi.mocked(deleteFileRecords).mockResolvedValue(1);
      mockFetch.mockRejectedValue(new Error('Network timeout'));

      const request = new Request('http://localhost/api/cron/cleanup-orphaned-files');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.physicalFilesDeleted).toBe(0);
      expect(body.failedPhysicalDeletes).toContain('file_1');
      // DB records should still be deleted despite physical file deletion failure
      expect(body.filesDeleted).toBe(1);
    });

    it('should still delete DB records even when physical deletes fail', async () => {
      vi.mocked(findOrphanedFileRecords).mockResolvedValue([ORPHAN_WITH_PATH]);
      vi.mocked(deleteFileRecords).mockResolvedValue(1);
      mockFetch.mockResolvedValue({ ok: false, status: 500 });

      const request = new Request('http://localhost/api/cron/cleanup-orphaned-files');
      await GET(request);

      expect(deleteFileRecords).toHaveBeenCalledWith(
        expect.anything(),
        [ORPHAN_WITH_PATH.id]
      );
    });

    it('should call createDriveServiceToken with correct params', async () => {
      vi.mocked(findOrphanedFileRecords).mockResolvedValue([ORPHAN_WITH_PATH]);
      vi.mocked(deleteFileRecords).mockResolvedValue(1);

      const request = new Request('http://localhost/api/cron/cleanup-orphaned-files');
      await GET(request);

      expect(createDriveServiceToken).toHaveBeenCalledWith(
        'system',
        'drive_1',
        ['files:delete'],
        '30s'
      );
    });
  });

  describe('error handling', () => {
    it('should return 500 when findOrphanedFileRecords throws', async () => {
      vi.mocked(findOrphanedFileRecords).mockRejectedValue(new Error('DB query failed'));

      const request = new Request('http://localhost/api/cron/cleanup-orphaned-files');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.success).toBe(false);
      expect(body.error).toBe('DB query failed');
    });

    it('should return "Unknown error" for non-Error throws', async () => {
      vi.mocked(findOrphanedFileRecords).mockRejectedValue(42);

      const request = new Request('http://localhost/api/cron/cleanup-orphaned-files');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Unknown error');
    });
  });
});

// ============================================================================
// POST /api/cron/cleanup-orphaned-files - Delegates to GET
// ============================================================================

describe('POST /api/cron/cleanup-orphaned-files', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateSignedCronRequest).mockReturnValue(null);
  });

  it('should delegate to GET handler', async () => {
    vi.mocked(findOrphanedFileRecords).mockResolvedValue([]);

    const request = new Request('http://localhost/api/cron/cleanup-orphaned-files', { method: 'POST' });
    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.orphansFound).toBe(0);
  });
});
