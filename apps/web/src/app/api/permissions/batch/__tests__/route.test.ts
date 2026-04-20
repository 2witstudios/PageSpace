import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for /api/permissions/batch
//
// Mock at the SERVICE SEAM level: auth, getBatchPagePermissions
// ============================================================================

const mockGetBatchPagePermissions = vi.fn();

vi.mock('@pagespace/lib/server', () => ({
  getBatchPagePermissions: (...args: unknown[]) => mockGetBatchPagePermissions(...args),
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    security: { warn: vi.fn() },
  },
  audit: vi.fn(),
  auditRequest: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

import { POST } from '../route';
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
      const response = await POST(request as never);

      expect(response.status).toBe(401);
    });

    it('should require CSRF for write operations', async () => {
      const request = createPostRequest({ pageIds: [] });
      await POST(request as never);

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['session'], requireCSRF: true }
      );
    });
  });

  describe('validation', () => {
    it('should return 400 when pageIds is not an array', async () => {
      const request = createPostRequest({ pageIds: 'not-an-array' });
      const response = await POST(request as never);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('pageIds must be an array');
    });

    it('should return 400 when pageIds is missing', async () => {
      const request = createPostRequest({});
      const response = await POST(request as never);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('pageIds must be an array');
    });

    it('should return empty permissions for empty pageIds array', async () => {
      const request = createPostRequest({ pageIds: [] });
      const response = await POST(request as never);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({
        permissions: {},
        stats: { total: 0, accessible: 0, denied: 0, processingTimeMs: 0 },
      });
    });

    it('should return 400 when pageIds exceeds 100', async () => {
      const pageIds = Array.from({ length: 101 }, (_, i) => `page_${i}`);
      const request = createPostRequest({ pageIds });
      const response = await POST(request as never);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Maximum 100 page IDs allowed per request');
    });

    it('should return 400 when pageIds contains non-string values', async () => {
      const request = createPostRequest({ pageIds: [123, 'page_1'] });
      const response = await POST(request as never);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('All pageIds must be non-empty strings');
    });

    it('should return 400 when pageIds contains empty strings', async () => {
      const request = createPostRequest({ pageIds: ['page_1', ''] });
      const response = await POST(request as never);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('All pageIds must be non-empty strings');
    });
  });

  describe('service integration', () => {
    it('should call getBatchPagePermissions with userId and pageIds', async () => {
      const pageIds = ['page_1', 'page_2'];
      const request = createPostRequest({ pageIds });
      await POST(request as never);

      expect(mockGetBatchPagePermissions).toHaveBeenCalledWith(mockUserId, pageIds);
    });
  });

  describe('response contract', () => {
    it('should return only viewable pages in permissions and count them as accessible', async () => {
      const permissionsMap = new Map([
        ['page_1', { canView: true, canEdit: true, canShare: false, canDelete: false }],
        ['page_2', { canView: true, canEdit: false, canShare: false, canDelete: false }],
        ['page_3', { canView: false, canEdit: false, canShare: false, canDelete: false }],
      ]);
      mockGetBatchPagePermissions.mockResolvedValue(permissionsMap);

      const request = createPostRequest({ pageIds: ['page_1', 'page_2', 'page_3'] });
      const response = await POST(request as never);
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
      await POST(request as never);

      const debugCallArgs = vi.mocked(loggers.api.debug).mock.calls[0];
      expect(debugCallArgs[0]).toBe('Batch permission check completed');
      const debugPayload = debugCallArgs[1] as Record<string, unknown>;
      expect(debugPayload.userId).toBe(mockUserId);
      expect(debugPayload.requestedPages).toBe(1);
      expect(debugPayload.accessiblePages).toBe(0);
      expect(debugPayload).toHaveProperty('processingTimeMs');
      expect(debugPayload).toHaveProperty('avgTimePerPage');
    });

    it('should log warning when processing takes over 500ms', async () => {
      // Drive the slow-path branch deterministically by stubbing Date.now for the
      // two reads that bracket getBatchPagePermissions (startTime / endTime) —
      // avoids a real 500ms+ busy-wait and the scheduler flakiness it introduces
      // on CI.
      const nowSpy = vi.spyOn(Date, 'now')
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(510);
      mockGetBatchPagePermissions.mockResolvedValue(new Map());

      try {
        const request = createPostRequest({ pageIds: ['page_1'] });
        await POST(request as never);

        const warnCallArgs = vi.mocked(loggers.api.warn).mock.calls[0];
        expect(warnCallArgs[0]).toBe('Slow batch permission check');
        const warnPayload = warnCallArgs[1] as Record<string, unknown>;
        expect(warnPayload.userId).toBe(mockUserId);
        expect(warnPayload.pageCount).toBe(1);
        expect(warnPayload).toHaveProperty('duration');
        expect(warnPayload).toHaveProperty('stats');
      } finally {
        nowSpy.mockRestore();
      }
    });
  });

  describe('error handling', () => {
    it('should return 500 when service throws an Error', async () => {
      mockGetBatchPagePermissions.mockRejectedValueOnce(new Error('Database failure'));

      const request = createPostRequest({ pageIds: ['page_1'] });
      const response = await POST(request as never);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to check permissions');
      expect(body.message).toBe('Database failure');
    });

    it('should return "Unknown error" when service throws non-Error', async () => {
      mockGetBatchPagePermissions.mockRejectedValueOnce('string-error');

      const request = createPostRequest({ pageIds: ['page_1'] });
      const response = await POST(request as never);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to check permissions');
      expect(body.message).toBe('Unknown error');
    });

    it('should log error when service throws', async () => {
      const error = new Error('Permission service down');
      mockGetBatchPagePermissions.mockRejectedValueOnce(error);

      const request = createPostRequest({ pageIds: ['page_1'] });
      await POST(request as never);

      expect(loggers.api.error).toHaveBeenCalledWith('Error in batch permission check', error);
    });
  });
});
