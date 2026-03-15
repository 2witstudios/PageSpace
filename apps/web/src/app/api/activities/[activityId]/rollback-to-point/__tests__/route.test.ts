/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for /api/activities/[activityId]/rollback-to-point
//
// Tests GET (preview) and POST (execute) handlers for rollback-to-point.
// ============================================================================

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@/services/api', () => ({
  previewRollbackToPoint: vi.fn(),
  executeRollbackToPoint: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('@/lib/logging/mask', () => ({
  maskIdentifier: vi.fn((id: string) => `***${id.slice(-4)}`),
}));

vi.mock('@/lib/websocket', () => ({
  broadcastPageEvent: vi.fn(),
  createPageEventPayload: vi.fn((...args: unknown[]) => args),
  broadcastDriveEvent: vi.fn(),
  createDriveEventPayload: vi.fn((...args: unknown[]) => args),
}));

vi.mock('@pagespace/lib/services/drive-member-service', () => ({
  getDriveRecipientUserIds: vi.fn().mockResolvedValue(['user_1']),
}));

import { GET, POST } from '../route';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { previewRollbackToPoint, executeRollbackToPoint } from '@/services/api';
import { broadcastPageEvent, broadcastDriveEvent } from '@/lib/websocket';

// ============================================================================
// Test Helpers
// ============================================================================

const mockWebAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session-id',
  adminRoleVersion: 0,
  role: 'user',
});

const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

const mockUserId = 'user_123';
const mockActivityId = 'activity_456';
const mockParams = Promise.resolve({ activityId: mockActivityId });

// ============================================================================
// GET /api/activities/[activityId]/rollback-to-point
// ============================================================================

describe('GET /api/activities/[activityId]/rollback-to-point', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request(`https://example.com/api/activities/${mockActivityId}/rollback-to-point`);
      const response = await GET(request, { params: mockParams });

      expect(response.status).toBe(401);
    });

    it('should use session-only auth (no MCP)', async () => {
      vi.mocked(previewRollbackToPoint).mockResolvedValue({
        activitiesAffected: [],
        warnings: [],
      } as any);

      const request = new Request(`https://example.com/api/activities/${mockActivityId}/rollback-to-point`);
      await GET(request, { params: mockParams });

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['session'] }
      );
    });
  });

  describe('validation', () => {
    it('should return 400 for invalid context parameter', async () => {
      const request = new Request(
        `https://example.com/api/activities/${mockActivityId}/rollback-to-point?context=invalid`
      );
      const response = await GET(request, { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toContain('Invalid context');
    });

    it('should default to page context', async () => {
      vi.mocked(previewRollbackToPoint).mockResolvedValue({
        activitiesAffected: [],
        warnings: [],
      } as any);

      const request = new Request(`https://example.com/api/activities/${mockActivityId}/rollback-to-point`);
      await GET(request, { params: mockParams });

      expect(previewRollbackToPoint).toHaveBeenCalledWith(
        mockActivityId,
        mockUserId,
        'page'
      );
    });
  });

  describe('success', () => {
    it('should return rollback preview', async () => {
      const mockPreview = {
        activitiesAffected: [{ id: 'act_1', resourceType: 'page' }],
        warnings: [],
      };
      vi.mocked(previewRollbackToPoint).mockResolvedValue(mockPreview as any);

      const request = new Request(`https://example.com/api/activities/${mockActivityId}/rollback-to-point?context=drive`);
      const response = await GET(request, { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual(mockPreview);
    });

    it('should return 404 when preview fails', async () => {
      vi.mocked(previewRollbackToPoint).mockResolvedValue(null);

      const request = new Request(`https://example.com/api/activities/${mockActivityId}/rollback-to-point`);
      const response = await GET(request, { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Activity not found or preview failed');
    });
  });

  describe('error handling', () => {
    it('should return 400 when preview throws', async () => {
      vi.mocked(previewRollbackToPoint).mockRejectedValue(new Error('Permission denied'));

      const request = new Request(`https://example.com/api/activities/${mockActivityId}/rollback-to-point`);
      const response = await GET(request, { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Permission denied');
    });
  });
});

// ============================================================================
// POST /api/activities/[activityId]/rollback-to-point
// ============================================================================

describe('POST /api/activities/[activityId]/rollback-to-point', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
  });

  const createPostRequest = (body: object) => {
    return new Request(`https://example.com/api/activities/${mockActivityId}/rollback-to-point`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  };

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const response = await POST(createPostRequest({ context: 'page' }), { params: mockParams });

      expect(response.status).toBe(401);
    });

    it('should require CSRF for write operations', async () => {
      vi.mocked(previewRollbackToPoint).mockResolvedValue({
        activitiesAffected: [],
        warnings: [],
      } as any);
      vi.mocked(executeRollbackToPoint).mockResolvedValue({
        success: true,
        activitiesRolledBack: 0,
      } as any);

      await POST(createPostRequest({ context: 'page' }), { params: mockParams });

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        expect.any(Request),
        expect.objectContaining({ requireCSRF: true })
      );
    });
  });

  describe('validation', () => {
    it('should return 400 for invalid JSON body', async () => {
      const request = new Request(`https://example.com/api/activities/${mockActivityId}/rollback-to-point`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not valid json',
      });

      const response = await POST(request, { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid JSON body');
    });

    it('should return 400 when context is missing', async () => {
      const response = await POST(createPostRequest({}), { params: mockParams });

      expect(response.status).toBe(400);
    });

    it('should return 400 for invalid context value', async () => {
      const response = await POST(createPostRequest({ context: 'invalid' }), { params: mockParams });

      expect(response.status).toBe(400);
    });

    it('should accept valid context values', async () => {
      const validContexts = ['page', 'drive', 'user_dashboard'];

      for (const context of validContexts) {
        vi.clearAllMocks();
        vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
        vi.mocked(isAuthError).mockReturnValue(false);
        vi.mocked(previewRollbackToPoint).mockResolvedValue({
          activitiesAffected: [],
          warnings: [],
        } as any);
        vi.mocked(executeRollbackToPoint).mockResolvedValue({
          success: true,
          activitiesRolledBack: 0,
        } as any);

        const response = await POST(createPostRequest({ context }), { params: mockParams });

        expect(response.status).toBe(200);
      }
    });
  });

  describe('execution', () => {
    it('should return 404 when preview fails', async () => {
      vi.mocked(previewRollbackToPoint).mockResolvedValue(null);

      const response = await POST(createPostRequest({ context: 'page' }), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Activity not found or preview failed');
    });

    it('should return 400 when rollback execution fails', async () => {
      vi.mocked(previewRollbackToPoint).mockResolvedValue({
        activitiesAffected: [],
        warnings: [],
      } as any);
      vi.mocked(executeRollbackToPoint).mockResolvedValue({
        success: false,
        errors: ['Permission denied'],
      } as any);

      const response = await POST(createPostRequest({ context: 'page' }), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Permission denied');
      expect(body.errors).toContain('Permission denied');
    });

    it('should return success with count when rollback succeeds', async () => {
      vi.mocked(previewRollbackToPoint).mockResolvedValue({
        activitiesAffected: [{ id: 'a1', resourceType: 'page', pageId: 'p1', driveId: 'd1' }],
        warnings: [],
      } as any);
      vi.mocked(executeRollbackToPoint).mockResolvedValue({
        success: true,
        activitiesRolledBack: 3,
      } as any);

      const response = await POST(createPostRequest({ context: 'page' }), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.activitiesRolledBack).toBe(3);
      expect(body.message).toBe('Rolled back 3 changes');
    });

    it('should pass force option to execution', async () => {
      vi.mocked(previewRollbackToPoint).mockResolvedValue({
        activitiesAffected: [],
        warnings: [],
      } as any);
      vi.mocked(executeRollbackToPoint).mockResolvedValue({
        success: true,
        activitiesRolledBack: 0,
      } as any);

      await POST(createPostRequest({ context: 'page', force: true }), { params: mockParams });

      expect(executeRollbackToPoint).toHaveBeenCalledWith(
        mockActivityId,
        mockUserId,
        'page',
        expect.anything(),
        expect.objectContaining({ force: true })
      );
    });
  });

  describe('real-time broadcasts', () => {
    it('should broadcast page events for affected page resources', async () => {
      vi.mocked(previewRollbackToPoint).mockResolvedValue({
        activitiesAffected: [
          { id: 'a1', resourceType: 'page', pageId: 'p1', driveId: 'd1', resourceTitle: 'Test Page' },
        ],
        warnings: [],
      } as any);
      vi.mocked(executeRollbackToPoint).mockResolvedValue({
        success: true,
        activitiesRolledBack: 1,
      } as any);

      await POST(createPostRequest({ context: 'page' }), { params: mockParams });

      expect(broadcastPageEvent).toHaveBeenCalled();
    });

    it('should broadcast drive events for affected drive resources', async () => {
      vi.mocked(previewRollbackToPoint).mockResolvedValue({
        activitiesAffected: [
          { id: 'a1', resourceType: 'drive', pageId: null, driveId: 'd1', resourceTitle: 'Test Drive' },
        ],
        warnings: [],
      } as any);
      vi.mocked(executeRollbackToPoint).mockResolvedValue({
        success: true,
        activitiesRolledBack: 1,
      } as any);

      await POST(createPostRequest({ context: 'drive' }), { params: mockParams });

      expect(broadcastDriveEvent).toHaveBeenCalled();
    });

    it('should deduplicate broadcasts for same page', async () => {
      vi.mocked(previewRollbackToPoint).mockResolvedValue({
        activitiesAffected: [
          { id: 'a1', resourceType: 'page', pageId: 'p1', driveId: 'd1', resourceTitle: 'Test' },
          { id: 'a2', resourceType: 'page', pageId: 'p1', driveId: 'd1', resourceTitle: 'Test' },
        ],
        warnings: [],
      } as any);
      vi.mocked(executeRollbackToPoint).mockResolvedValue({
        success: true,
        activitiesRolledBack: 2,
      } as any);

      await POST(createPostRequest({ context: 'page' }), { params: mockParams });

      // broadcastPageEvent called twice per unique page (updated + content-updated), not 4 times
      expect(broadcastPageEvent).toHaveBeenCalledTimes(2);
    });
  });
});
