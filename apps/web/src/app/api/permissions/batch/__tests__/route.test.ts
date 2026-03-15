import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for /api/permissions/batch
//
// Mock at the SERVICE SEAM level: auth, getBatchPagePermissions,
// getPermissionCacheStats
// ============================================================================

const mockGetBatchPagePermissions = vi.fn();
const mockGetPermissionCacheStats = vi.fn();

vi.mock('@pagespace/lib/server', () => ({
  getBatchPagePermissions: (...args: unknown[]) => mockGetBatchPagePermissions(...args),
  getPermissionCacheStats: (...args: unknown[]) => mockGetPermissionCacheStats(...args),
  loggers: {
    api: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  },
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

import { POST, GET } from '../route';
import { loggers } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

// ============================================================================
// Test Helpers
// ============================================================================

const mockWebAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session-id',
  role: 'user',
  adminRoleVersion: 0,
});

const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

function createPostRequest(body: unknown): Request {
  return new Request('https://example.com/api/permissions/batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function createGetRequest(): Request {
  return new Request('https://example.com/api/permissions/batch');
}

// ============================================================================
// POST /api/permissions/batch
// ============================================================================

describe('POST /api/permissions/batch', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
    mockGetBatchPagePermissions.mockResolvedValue(new Map());
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = createPostRequest({ pageIds: ['page_1'] });
      const response = await POST(request);

      expect(response.status).toBe(401);
    });

    it('should require CSRF for write operations', async () => {
      const request = createPostRequest({ pageIds: [] });
      await POST(request);

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['session'], requireCSRF: true }
      );
    });
  });

  describe('validation', () => {
    it('should return 400 when pageIds is not an array', async () => {
      const request = createPostRequest({ pageIds: 'not-an-array' });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('pageIds must be an array');
    });

    it('should return 400 when pageIds is missing', async () => {
      const request = createPostRequest({});
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('pageIds must be an array');
    });

    it('should return empty permissions for empty pageIds array', async () => {
      const request = createPostRequest({ pageIds: [] });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({
        permissions: {},
        stats: { total: 0, accessible: 0, cacheHits: 0 },
      });
    });

    it('should return 400 when pageIds exceeds 100', async () => {
      const pageIds = Array.from({ length: 101 }, (_, i) => `page_${i}`);
      const request = createPostRequest({ pageIds });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Maximum 100 page IDs allowed per request');
    });

    it('should return 400 when pageIds contains non-string values', async () => {
      const request = createPostRequest({ pageIds: [123, 'page_1'] });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('All pageIds must be non-empty strings');
    });

    it('should return 400 when pageIds contains empty strings', async () => {
      const request = createPostRequest({ pageIds: ['page_1', ''] });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('All pageIds must be non-empty strings');
    });
  });

  describe('service integration', () => {
    it('should call getBatchPagePermissions with userId and pageIds', async () => {
      const pageIds = ['page_1', 'page_2'];
      const request = createPostRequest({ pageIds });
      await POST(request);

      expect(mockGetBatchPagePermissions).toHaveBeenCalledWith(mockUserId, pageIds);
    });
  });

  describe('response contract', () => {
    it('should return permissions map and stats on success', async () => {
      const permissionsMap = new Map([
        ['page_1', { canView: true, canEdit: true, canShare: false, canDelete: false }],
        ['page_2', { canView: true, canEdit: false, canShare: false, canDelete: false }],
      ]);
      mockGetBatchPagePermissions.mockResolvedValue(permissionsMap);

      const request = createPostRequest({ pageIds: ['page_1', 'page_2', 'page_3'] });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.permissions).toEqual({
        page_1: { canView: true, canEdit: true, canShare: false, canDelete: false },
        page_2: { canView: true, canEdit: false, canShare: false, canDelete: false },
      });
      expect(body.stats.total).toBe(3);
      expect(body.stats.accessible).toBe(2);
      expect(body.stats.denied).toBe(1);
      expect(body.stats).toHaveProperty('processingTimeMs');
    });

    it('should log debug metrics on completion', async () => {
      mockGetBatchPagePermissions.mockResolvedValue(new Map());

      const request = createPostRequest({ pageIds: ['page_1'] });
      await POST(request);

      expect(loggers.api.debug).toHaveBeenCalledWith(
        'Batch permission check completed',
        expect.objectContaining({
          userId: mockUserId,
          requestedPages: 1,
          accessiblePages: 0,
        })
      );
    });

    it('should log warning when processing takes over 500ms', async () => {
      // Simulate slow processing by making getBatchPagePermissions take >500ms
      mockGetBatchPagePermissions.mockImplementation(async () => {
        const start = Date.now();
        // Busy-wait for at least 501ms
        while (Date.now() - start < 510) {
          // spin
        }
        return new Map();
      });

      const request = createPostRequest({ pageIds: ['page_1'] });
      await POST(request);

      expect(loggers.api.warn).toHaveBeenCalledWith(
        'Slow batch permission check',
        expect.objectContaining({
          userId: mockUserId,
          pageCount: 1,
        })
      );
    });
  });

  describe('error handling', () => {
    it('should return 500 when service throws an Error', async () => {
      mockGetBatchPagePermissions.mockRejectedValue(new Error('Database failure'));

      const request = createPostRequest({ pageIds: ['page_1'] });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to check permissions');
      expect(body.message).toBe('Database failure');
    });

    it('should return "Unknown error" when service throws non-Error', async () => {
      mockGetBatchPagePermissions.mockRejectedValue('string-error');

      const request = createPostRequest({ pageIds: ['page_1'] });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to check permissions');
      expect(body.message).toBe('Unknown error');
    });

    it('should log error when service throws', async () => {
      const error = new Error('Permission service down');
      mockGetBatchPagePermissions.mockRejectedValue(error);

      const request = createPostRequest({ pageIds: ['page_1'] });
      await POST(request);

      expect(loggers.api.error).toHaveBeenCalledWith('Error in batch permission check', error);
    });
  });
});

// ============================================================================
// GET /api/permissions/batch
// ============================================================================

describe('GET /api/permissions/batch', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
    mockGetPermissionCacheStats.mockReturnValue({
      size: 100,
      hits: 50,
      misses: 50,
    });
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = createGetRequest();
      const response = await GET(request);

      expect(response.status).toBe(401);
    });

    it('should use read auth options without CSRF requirement', async () => {
      const request = createGetRequest();
      await GET(request);

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['session'], requireCSRF: false }
      );
    });
  });

  describe('response contract', () => {
    it('should return cache stats on success', async () => {
      const cacheStats = { size: 200, hits: 150, misses: 50 };
      mockGetPermissionCacheStats.mockReturnValue(cacheStats);

      const request = createGetRequest();
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.cache).toEqual(cacheStats);
      expect(body).toHaveProperty('timestamp');
    });
  });

  describe('error handling', () => {
    it('should return 500 when cache stats throws an Error', async () => {
      mockGetPermissionCacheStats.mockImplementation(() => {
        throw new Error('Cache unavailable');
      });

      const request = createGetRequest();
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to get cache statistics');
      expect(body.message).toBe('Cache unavailable');
    });

    it('should return "Unknown error" when cache stats throws non-Error', async () => {
      mockGetPermissionCacheStats.mockImplementation(() => {
        throw 'non-error-thrown';
      });

      const request = createGetRequest();
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to get cache statistics');
      expect(body.message).toBe('Unknown error');
    });

    it('should log error when cache stats throws', async () => {
      const error = new Error('Stats failure');
      mockGetPermissionCacheStats.mockImplementation(() => {
        throw error;
      });

      const request = createGetRequest();
      await GET(request);

      expect(loggers.api.error).toHaveBeenCalledWith('Error getting permission cache stats', error);
    });
  });
});
