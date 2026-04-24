/**
 * Contract tests for GET /api/pages/[pageId]/processing-status
 *
 * Tests verify:
 * - Authentication via authenticateRequestWithOptions
 * - Authorization via canUserViewPage
 * - Page existence check (404 if missing)
 * - Returns final status when not pending/processing
 * - Fetches queue status from processor for pending/processing pages
 * - hasContent flag logic
 * - Error handling (500 on failure)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// Mock external boundaries BEFORE imports
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result: unknown) => {
    return result !== null && typeof result === 'object' && 'error' in result;
  }),
}));

vi.mock('@pagespace/lib/permissions/permissions', () => ({
    canUserViewPage: vi.fn(),
}));
vi.mock('@pagespace/lib/services/validated-service-token', () => ({
    createPageServiceToken: vi.fn(),
}));

vi.mock('@pagespace/db', () => {
  const limit = vi.fn();
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });

  return {
    db: { select },
    pages: {
      id: 'id',
      processingStatus: 'processingStatus',
      processingError: 'processingError',
      extractionMethod: 'extractionMethod',
      extractionMetadata: 'extractionMetadata',
      processedAt: 'processedAt',
      content: 'content',
    },
    eq: vi.fn((a: unknown, b: unknown) => [a, b]),
  };
});

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { GET } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { createPageServiceToken } from '@pagespace/lib/services/validated-service-token'
import { canUserViewPage } from '@pagespace/lib/permissions/permissions';
import { db } from '@pagespace/db';

// Test helpers
const mockUserId = 'user_123';
const mockPageId = 'page_abc';

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

const createRequest = () =>
  new Request(`https://example.com/api/pages/${mockPageId}/processing-status`, { method: 'GET' });

const mockContext = { params: Promise.resolve({ pageId: mockPageId }) };

// Helper to set up db.select chain result
function mockDbSelectResult(result: unknown[]) {
  const limit = vi.fn().mockResolvedValue(result);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  vi.mocked(db.select).mockReturnValue({ from } as never);
}

describe('GET /api/pages/[pageId]/processing-status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(canUserViewPage).mockResolvedValue(true);
    vi.mocked(createPageServiceToken).mockResolvedValue({ token: 'service-token-123' } as never);

    // Default: completed page
    mockDbSelectResult([{
      processingStatus: 'completed',
      processingError: null,
      extractionMethod: 'tika',
      extractionMetadata: { pages: 5 },
      processedAt: new Date('2024-01-01'),
      content: 'Some extracted content',
    }]);
  });

  describe('authentication', () => {
    it('returns 401 when user is not authenticated', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const response = await GET(createRequest(), mockContext);

      expect(response.status).toBe(401);
      expect(canUserViewPage).not.toHaveBeenCalled();
    });
  });

  describe('authorization', () => {
    it('returns 403 when user cannot view the page', async () => {
      vi.mocked(canUserViewPage).mockResolvedValue(false);

      const response = await GET(createRequest(), mockContext);
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toMatch(/access denied/i);
    });
  });

  describe('page existence', () => {
    it('returns 404 when page does not exist', async () => {
      mockDbSelectResult([]);

      const response = await GET(createRequest(), mockContext);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toMatch(/not found/i);
    });
  });

  describe('completed/failed status (non-pending)', () => {
    it('returns final status for completed page with content', async () => {
      const response = await GET(createRequest(), mockContext);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.status).toBe('completed');
      expect(body.error).toBeNull();
      expect(body.extractionMethod).toBe('tika');
      expect(body.metadata).toEqual({ pages: 5 });
      expect(body.hasContent).toBe(true);
    });

    it('returns hasContent false when content is null', async () => {
      mockDbSelectResult([{
        processingStatus: 'completed',
        processingError: null,
        extractionMethod: 'tika',
        extractionMetadata: null,
        processedAt: new Date('2024-01-01'),
        content: null,
      }]);

      const response = await GET(createRequest(), mockContext);
      const body = await response.json();

      expect(body.hasContent).toBe(false);
    });

    it('returns hasContent false when content is empty string', async () => {
      mockDbSelectResult([{
        processingStatus: 'completed',
        processingError: null,
        extractionMethod: null,
        extractionMetadata: null,
        processedAt: null,
        content: '',
      }]);

      const response = await GET(createRequest(), mockContext);
      const body = await response.json();

      expect(body.hasContent).toBe(false);
    });

    it('returns final status for failed page', async () => {
      mockDbSelectResult([{
        processingStatus: 'failed',
        processingError: 'Extraction timeout',
        extractionMethod: null,
        extractionMetadata: null,
        processedAt: null,
        content: null,
      }]);

      const response = await GET(createRequest(), mockContext);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.status).toBe('failed');
      expect(body.error).toBe('Extraction timeout');
      expect(body.hasContent).toBe(false);
    });
  });

  describe('pending/processing status (queue check)', () => {
    it('fetches queue status for pending page', async () => {
      mockDbSelectResult([{
        processingStatus: 'pending',
        processingError: null,
        extractionMethod: null,
        extractionMetadata: null,
        processedAt: null,
        content: null,
      }]);

      mockFetch.mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({
          'ingest-file': { pending: 3, active: 1, completed: 10, failed: 0 },
        }),
      });

      const response = await GET(createRequest(), mockContext);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.status).toBe('pending');
      expect(body.queuePosition).toBe(3);
      expect(body.activeJobs).toBe(1);
      expect(body.estimatedWaitTime).toBe(45); // 3 * 15
      expect(body.message).toBe('File is being processed. Please check back shortly.');
    });

    it('fetches queue status for processing page', async () => {
      mockDbSelectResult([{
        processingStatus: 'processing',
        processingError: null,
        extractionMethod: null,
        extractionMetadata: null,
        processedAt: null,
        content: null,
      }]);

      mockFetch.mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({
          'ingest-file': { pending: 0, active: 2 },
        }),
      });

      const response = await GET(createRequest(), mockContext);
      const body = await response.json();

      expect(body.status).toBe('processing');
      expect(body.queuePosition).toBe(0);
      expect(body.activeJobs).toBe(2);
      expect(body.estimatedWaitTime).toBe(0);
    });

    it('handles queue status response with missing ingest-file bucket', async () => {
      mockDbSelectResult([{
        processingStatus: 'pending',
        processingError: null,
        extractionMethod: null,
        extractionMetadata: null,
        processedAt: null,
        content: null,
      }]);

      mockFetch.mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({
          'other-queue': { pending: 5 },
        }),
      });

      const response = await GET(createRequest(), mockContext);
      const body = await response.json();

      expect(body.queuePosition).toBe(0);
      expect(body.activeJobs).toBe(0);
      expect(body.estimatedWaitTime).toBe(0);
    });

    it('handles non-ok queue status response', async () => {
      mockDbSelectResult([{
        processingStatus: 'pending',
        processingError: null,
        extractionMethod: null,
        extractionMetadata: null,
        processedAt: null,
        content: null,
      }]);

      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
      });

      const response = await GET(createRequest(), mockContext);
      const body = await response.json();

      // Should still return status with default queue info
      expect(response.status).toBe(200);
      expect(body.status).toBe('pending');
      expect(body.queuePosition).toBe(0);
      expect(body.activeJobs).toBe(0);
    });

    it('handles non-object queue status response', async () => {
      mockDbSelectResult([{
        processingStatus: 'pending',
        processingError: null,
        extractionMethod: null,
        extractionMetadata: null,
        processedAt: null,
        content: null,
      }]);

      mockFetch.mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(null),
      });

      const response = await GET(createRequest(), mockContext);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.queuePosition).toBe(0);
    });

    it('creates service token with correct parameters', async () => {
      mockDbSelectResult([{
        processingStatus: 'pending',
        processingError: null,
        extractionMethod: null,
        extractionMetadata: null,
        processedAt: null,
        content: null,
      }]);

      mockFetch.mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({}),
      });

      await GET(createRequest(), mockContext);

      expect(createPageServiceToken).toHaveBeenCalledWith(
        mockUserId,
        mockPageId,
        ['queue:read'],
        '2m'
      );
    });
  });

  describe('error handling', () => {
    it('returns 500 when database query throws', async () => {
      const limit = vi.fn().mockRejectedValueOnce(new Error('DB error'));
      const where = vi.fn().mockReturnValue({ limit });
      const from = vi.fn().mockReturnValue({ where });
      vi.mocked(db.select).mockReturnValue({ from } as never);

      const response = await GET(createRequest(), mockContext);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toMatch(/failed/i);
    });

    it('returns 500 when fetch throws', async () => {
      mockDbSelectResult([{
        processingStatus: 'pending',
        processingError: null,
        extractionMethod: null,
        extractionMetadata: null,
        processedAt: null,
        content: null,
      }]);

      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const response = await GET(createRequest(), mockContext);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toMatch(/failed/i);
    });
  });
});
