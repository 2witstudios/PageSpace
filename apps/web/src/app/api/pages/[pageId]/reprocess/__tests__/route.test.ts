/**
 * Contract tests for POST /api/pages/[pageId]/reprocess
 *
 * Tests verify:
 * - Authentication via authenticateRequestWithOptions
 * - Page existence check (404 if missing)
 * - Authorization via canUserEditPage (403 if denied)
 * - Reset page status via applyPageMutation
 * - Service token creation
 * - Processor enqueue call and response handling
 * - Error handling for processor failures
 * - Error handling (500 on unexpected failures)
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

vi.mock('@pagespace/lib', () => ({
  createPageServiceToken: vi.fn(),
}));

vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  getActorInfo: vi.fn(),
}));

vi.mock('@/services/api/page-mutation-service', () => ({
  applyPageMutation: vi.fn(),
}));

vi.mock('@pagespace/lib/permissions', () => ({
  canUserEditPage: vi.fn(),
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
      revision: 'revision',
    },
    eq: vi.fn((a: unknown, b: unknown) => [a, b]),
  };
});

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { POST } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { createPageServiceToken } from '@pagespace/lib';
import { getActorInfo } from '@pagespace/lib/monitoring/activity-logger';
import { applyPageMutation } from '@/services/api/page-mutation-service';
import { canUserEditPage } from '@pagespace/lib/permissions/permissions';
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
  new Request(`https://example.com/api/pages/${mockPageId}/reprocess`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });

const mockContext = { params: Promise.resolve({ pageId: mockPageId }) };

// Helper to set up db.select chain
function mockDbSelectResult(result: unknown[]) {
  const limit = vi.fn().mockResolvedValue(result);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  vi.mocked(db.select).mockReturnValue({ from } as never);
}

describe('POST /api/pages/[pageId]/reprocess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(canUserEditPage).mockResolvedValue(true);
    vi.mocked(getActorInfo).mockResolvedValue({
      actorEmail: 'test@example.com',
      actorDisplayName: 'Test User',
    });
    vi.mocked(applyPageMutation).mockResolvedValue(undefined as never);
    vi.mocked(createPageServiceToken).mockResolvedValue({ token: 'service-token-123' } as never);

    // Default: page exists with revision
    mockDbSelectResult([{ revision: 5 }]);

    // Default: processor enqueue succeeds
    mockFetch.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ jobId: 'job_xyz' }),
    });
  });

  describe('authentication', () => {
    it('returns 401 when user is not authenticated', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const response = await POST(createRequest(), mockContext);

      expect(response.status).toBe(401);
      expect(canUserEditPage).not.toHaveBeenCalled();
    });
  });

  describe('page existence', () => {
    it('returns 404 when page does not exist', async () => {
      mockDbSelectResult([]);

      const response = await POST(createRequest(), mockContext);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toMatch(/not found/i);
    });
  });

  describe('authorization', () => {
    it('returns 403 when user cannot edit the page', async () => {
      vi.mocked(canUserEditPage).mockResolvedValue(false);

      const response = await POST(createRequest(), mockContext);
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toMatch(/permission/i);
    });

    it('checks edit permission for the caller and page', async () => {
      await POST(createRequest(), mockContext);

      expect(canUserEditPage).toHaveBeenCalledWith(mockUserId, mockPageId);
    });
  });

  describe('reprocessing flow', () => {
    it('returns success with jobId on successful reprocess', async () => {
      const response = await POST(createRequest(), mockContext);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.jobId).toBe('job_xyz');
      expect(body.message).toMatch(/reprocessing/i);
    });

    it('calls applyPageMutation with correct parameters', async () => {
      await POST(createRequest(), mockContext);

      expect(applyPageMutation).toHaveBeenCalledWith({
        pageId: mockPageId,
        operation: 'update',
        updates: {
          processingStatus: 'pending',
          processingError: null,
        },
        updatedFields: ['processingStatus', 'processingError'],
        expectedRevision: 5,
        context: {
          userId: mockUserId,
          actorEmail: 'test@example.com',
          actorDisplayName: 'Test User',
          metadata: { source: 'reprocess' },
        },
        source: 'system',
      });
    });

    it('creates service token with correct parameters', async () => {
      await POST(createRequest(), mockContext);

      expect(createPageServiceToken).toHaveBeenCalledWith(
        mockUserId,
        mockPageId,
        ['files:ingest'],
        '2m'
      );
    });

    it('calls processor enqueue endpoint with service token', async () => {
      await POST(createRequest(), mockContext);

      const fetchArgs = vi.mocked(mockFetch).mock.calls[0];
      expect(fetchArgs[0]).toContain(`/api/ingest/by-page/${mockPageId}`);
      expect(fetchArgs[1]).toEqual({
        method: 'POST',
        headers: { Authorization: 'Bearer service-token-123' },
      });
    });
  });

  describe('processor failure', () => {
    it('returns 500 when processor responds with error (with JSON body)', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        json: vi.fn().mockResolvedValue({ error: 'Queue full' }),
      });

      const response = await POST(createRequest(), mockContext);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toMatch(/failed/i);
    });

    it('returns 500 when processor responds with error (non-JSON body)', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        json: vi.fn().mockRejectedValueOnce(new Error('Not JSON')),
      });

      const response = await POST(createRequest(), mockContext);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toMatch(/failed/i);
    });
  });

  describe('error handling', () => {
    it('returns 500 when database query throws', async () => {
      const limit = vi.fn().mockRejectedValueOnce(new Error('DB error'));
      const where = vi.fn().mockReturnValue({ limit });
      const from = vi.fn().mockReturnValue({ where });
      vi.mocked(db.select).mockReturnValue({ from } as never);

      const response = await POST(createRequest(), mockContext);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toMatch(/failed/i);
    });

    it('returns 500 when applyPageMutation throws', async () => {
      vi.mocked(applyPageMutation).mockRejectedValueOnce(new Error('Mutation failed'));

      const response = await POST(createRequest(), mockContext);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toMatch(/failed/i);
    });

    it('returns 500 when fetch throws', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const response = await POST(createRequest(), mockContext);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toMatch(/failed/i);
    });
  });
});
