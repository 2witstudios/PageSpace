/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for /api/channels/[pageId]/upload
//
// Tests POST handler for channel file uploads. The route authenticates,
// validates the channel, checks permissions and quotas, forwards to the
// processor service, and records the file in the database.
//
// jsdom's Request.formData() can hang, so we mock the request object directly.
// ============================================================================

// Mock global fetch for processor calls
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock dependencies
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      pages: { findFirst: vi.fn() },
      files: { findFirst: vi.fn() },
    },
    insert: vi.fn(),
  },
  pages: { id: 'id' },
  files: { id: 'id' },
  filePages: {},
  eq: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  canUserEditPage: vi.fn(),
}));

vi.mock('@pagespace/lib/services/storage-limits', () => ({
  checkStorageQuota: vi.fn(),
  updateStorageUsage: vi.fn().mockResolvedValue(undefined),
  getUserStorageQuota: vi.fn(),
  formatBytes: vi.fn((bytes: number) => `${bytes} B`),
}));

vi.mock('@pagespace/lib/services/upload-semaphore', () => ({
  uploadSemaphore: {
    acquireUploadSlot: vi.fn(),
    releaseUploadSlot: vi.fn(),
  },
}));

vi.mock('@pagespace/lib/services/memory-monitor', () => ({
  checkMemoryMiddleware: vi.fn(),
}));

vi.mock('@pagespace/lib/services/validated-service-token', () => ({
  createUploadServiceToken: vi.fn(),
  isPermissionDeniedError: vi.fn(),
}));

vi.mock('@pagespace/lib/utils/file-security', () => ({
  sanitizeFilenameForHeader: vi.fn((name: string) => name),
}));

vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  getActorInfo: vi.fn().mockResolvedValue({ name: 'Test User' }),
  logFileActivity: vi.fn(),
}));

import { db } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { canUserEditPage } from '@pagespace/lib/server';
import { checkStorageQuota, getUserStorageQuota } from '@pagespace/lib/services/storage-limits';
import { uploadSemaphore } from '@pagespace/lib/services/upload-semaphore';
import { checkMemoryMiddleware } from '@pagespace/lib/services/memory-monitor';
import { createUploadServiceToken, isPermissionDeniedError } from '@pagespace/lib/services/validated-service-token';
import { POST } from '../route';

// ============================================================================
// Test Helpers
// ============================================================================

const mockWebAuth = (userId: string, tokenVersion = 0): SessionAuthResult => ({
  userId,
  tokenVersion,
  tokenType: 'session',
  sessionId: 'test-session-id',
  adminRoleVersion: 0,
  role: 'user',
});

const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

const makeParams = (pageId: string) => ({
  params: Promise.resolve({ pageId }),
});

/**
 * Create a mock file object matching the File interface used by the route.
 */
const createMockFile = (name = 'test.txt', size = 12, type = 'text/plain') => ({
  name,
  size,
  type,
});

/**
 * Create a request with a mocked formData() method.
 * jsdom's Request.formData() can hang, so we mock it directly.
 */
const makeUploadRequest = (file?: { name: string; size: number; type: string }) => {
  const mockFormData = {
    get: vi.fn((key: string) => {
      if (key === 'file' && file) return file;
      return null;
    }),
    append: vi.fn(),
  };
  return {
    formData: vi.fn().mockResolvedValue(mockFormData),
    headers: new Headers(),
    url: 'http://localhost/api/channels/page_1/upload',
    method: 'POST',
  } as unknown as NextRequest;
};

const makeEmptyUploadRequest = () => makeUploadRequest();

// ============================================================================
// POST /api/channels/[pageId]/upload
// ============================================================================

describe('POST /api/channels/[pageId]/upload', () => {
  const mockUserId = 'user_123';
  const pageId = 'page_channel_1';

  const mockInsertChain = {
    values: vi.fn().mockReturnThis(),
    returning: vi.fn(),
    onConflictDoNothing: vi.fn().mockReturnThis(),
    onConflictDoUpdate: vi.fn().mockReturnThis(),
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Auth defaults
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    // Channel page exists and is valid
    vi.mocked(db.query.pages.findFirst).mockResolvedValue({
      id: pageId,
      type: 'CHANNEL',
      driveId: 'drive_1',
    } as any);

    // User has edit permission
    vi.mocked(canUserEditPage).mockResolvedValue(true);

    // Memory check passes
    vi.mocked(checkMemoryMiddleware).mockResolvedValue({ allowed: true });

    // Storage quota passes
    vi.mocked(checkStorageQuota).mockResolvedValue({ allowed: true, quota: null } as any);

    // User storage quota is available
    vi.mocked(getUserStorageQuota).mockResolvedValue({
      tier: 'free',
      quotaBytes: 1073741824,
      usedBytes: 0,
    } as any);

    // Upload slot is available
    vi.mocked(uploadSemaphore.acquireUploadSlot).mockResolvedValue('slot_1' as any);

    // Service token creation succeeds
    vi.mocked(createUploadServiceToken).mockResolvedValue({ token: 'test-service-token' } as any);
    vi.mocked(isPermissionDeniedError).mockReturnValue(false);

    // Processor returns success
    mockFetch.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        contentHash: 'hash_abc123',
        size: 12,
      }),
    });

    // DB insert chain
    vi.mocked(db.insert).mockReturnValue(mockInsertChain as any);
    mockInsertChain.values.mockReturnValue(mockInsertChain);
    mockInsertChain.onConflictDoNothing.mockReturnValue(mockInsertChain);
    mockInsertChain.returning.mockResolvedValue([{
      id: 'hash_abc123',
      driveId: 'drive_1',
      sizeBytes: 12,
      mimeType: 'text/plain',
    }]);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = makeUploadRequest(createMockFile());
      const response = await POST(request, makeParams(pageId));

      expect(response.status).toBe(401);
    });
  });

  describe('validation', () => {
    it('should return 404 when channel page not found', async () => {
      vi.mocked(db.query.pages.findFirst).mockResolvedValue(undefined as any);

      const request = makeUploadRequest(createMockFile());
      const response = await POST(request, makeParams(pageId));

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe('Channel not found');
    });

    it('should return 400 when page is not type CHANNEL', async () => {
      vi.mocked(db.query.pages.findFirst).mockResolvedValue({
        id: pageId,
        type: 'DOCUMENT',
        driveId: 'drive_1',
      } as any);

      const request = makeUploadRequest(createMockFile());
      const response = await POST(request, makeParams(pageId));

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('Not a channel');
    });

    it('should return 400 when channel has no driveId', async () => {
      vi.mocked(db.query.pages.findFirst).mockResolvedValue({
        id: pageId,
        type: 'CHANNEL',
        driveId: null,
      } as any);

      const request = makeUploadRequest(createMockFile());
      const response = await POST(request, makeParams(pageId));

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('Channel has no associated drive');
    });

    it('should return 400 when no file provided', async () => {
      const request = makeEmptyUploadRequest();
      const response = await POST(request, makeParams(pageId));

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('No file provided');
    });
  });

  describe('authorization', () => {
    it('should return 403 when user lacks edit permission', async () => {
      vi.mocked(canUserEditPage).mockResolvedValue(false);

      const request = makeUploadRequest(createMockFile());
      const response = await POST(request, makeParams(pageId));

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe('You need edit permission to upload files in this channel');
    });

    it('should return 403 when createUploadServiceToken throws permission denied', async () => {
      vi.mocked(createUploadServiceToken).mockRejectedValue(new Error('Permission denied'));
      vi.mocked(isPermissionDeniedError).mockReturnValue(true);

      const request = makeUploadRequest(createMockFile());
      const response = await POST(request, makeParams(pageId));

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe('Permission denied for file upload');
    });
  });

  describe('resource checks', () => {
    it('should return 503 when memory check fails', async () => {
      vi.mocked(checkMemoryMiddleware).mockResolvedValue({
        allowed: false,
        reason: 'Server memory pressure',
      });

      const request = makeUploadRequest(createMockFile());
      const response = await POST(request, makeParams(pageId));

      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body.error).toBe('Server memory pressure');
    });

    it('should return 413 when storage quota exceeded', async () => {
      vi.mocked(checkStorageQuota).mockResolvedValue({
        allowed: false,
        reason: 'Storage quota exceeded',
        quota: { used: 1000, total: 1000 },
      } as any);

      const request = makeUploadRequest(createMockFile());
      const response = await POST(request, makeParams(pageId));

      expect(response.status).toBe(413);
      const body = await response.json();
      expect(body.error).toBe('Storage quota exceeded');
    });

    it('should return 500 when storage quota not retrievable', async () => {
      vi.mocked(getUserStorageQuota).mockResolvedValue(null as any);

      const request = makeUploadRequest(createMockFile());
      const response = await POST(request, makeParams(pageId));

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe('Could not retrieve storage quota');
    });

    it('should return 429 when too many concurrent uploads', async () => {
      vi.mocked(uploadSemaphore.acquireUploadSlot).mockResolvedValue(null as any);

      const request = makeUploadRequest(createMockFile());
      const response = await POST(request, makeParams(pageId));

      expect(response.status).toBe(429);
      const body = await response.json();
      expect(body.error).toBe('Too many concurrent uploads. Please wait for current uploads to complete.');
    });
  });

  describe('processor interaction', () => {
    it('should handle processor upload failure', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        json: vi.fn().mockResolvedValue({ error: 'Processing failed' }),
      });

      const request = makeUploadRequest(createMockFile());
      const response = await POST(request, makeParams(pageId));

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe('Failed to upload file');
    });
  });

  describe('success responses', () => {
    it('should return file metadata with storageInfo on successful upload', async () => {
      vi.mocked(getUserStorageQuota)
        .mockResolvedValueOnce({
          tier: 'free',
          quotaBytes: 1073741824,
          usedBytes: 0,
        } as any)
        // Second call (after upload) returns updated quota
        .mockResolvedValueOnce({
          tier: 'free',
          quotaBytes: 1073741824,
          usedBytes: 12,
        } as any);

      const request = makeUploadRequest(createMockFile('photo.png', 1024, 'image/png'));
      const response = await POST(request, makeParams(pageId));

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.file).toBeDefined();
      expect(body.file.contentHash).toBe('hash_abc123');
      expect(body.file.mimeType).toBe('image/png');
      expect(body.storageInfo).toBeDefined();
    });

    it('should handle file deduplication when insert returns empty', async () => {
      // First insert call (for files): onConflictDoNothing returns empty
      mockInsertChain.returning
        .mockResolvedValueOnce([]) // files insert: conflict, already exists
        .mockResolvedValueOnce([]); // filePages insert

      // Fallback query finds existing file
      vi.mocked(db.query.files.findFirst).mockResolvedValue({
        id: 'hash_abc123',
        driveId: 'drive_1',
        sizeBytes: 12,
        mimeType: 'text/plain',
      } as any);

      const request = makeUploadRequest(createMockFile());
      const response = await POST(request, makeParams(pageId));

      expect(response.status).toBe(200);
      expect(db.query.files.findFirst).toHaveBeenCalled();
    });
  });

  describe('upload slot management', () => {
    it('should release upload slot on error', async () => {
      // Cause an error after acquiring the slot
      mockFetch.mockRejectedValue(new Error('Network error'));

      const request = makeUploadRequest(createMockFile());
      await POST(request, makeParams(pageId));

      // Slot should be released in the catch block
      expect(uploadSemaphore.releaseUploadSlot).toHaveBeenCalledWith('slot_1');
    });

    it('should release upload slot on success', async () => {
      vi.mocked(getUserStorageQuota)
        .mockResolvedValueOnce({
          tier: 'free',
          quotaBytes: 1073741824,
          usedBytes: 0,
        } as any)
        .mockResolvedValueOnce({
          tier: 'free',
          quotaBytes: 1073741824,
          usedBytes: 12,
        } as any);

      const request = makeUploadRequest(createMockFile());
      await POST(request, makeParams(pageId));

      expect(uploadSemaphore.releaseUploadSlot).toHaveBeenCalledWith('slot_1');
    });
  });
});
