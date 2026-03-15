/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for GET /api/activities/[activityId]
//
// Tests the route handler's contract for fetching a single activity log
// with rollback preview.
// ============================================================================

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
  checkMCPDriveScope: vi.fn(() => null),
  checkMCPPageScope: vi.fn(() => null),
}));

vi.mock('@/services/api', () => ({
  getActivityById: vi.fn(),
  previewRollback: vi.fn(),
}));

vi.mock('@pagespace/lib/permissions', () => ({
  canUserViewPage: vi.fn(),
  isUserDriveMember: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

import { GET } from '../route';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { getActivityById, previewRollback } from '@/services/api';
import { canUserViewPage, isUserDriveMember } from '@pagespace/lib/permissions';

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

const createActivity = (overrides: Record<string, unknown> = {}) => ({
  id: mockActivityId,
  userId: mockUserId,
  driveId: 'drive_1',
  pageId: 'page_1',
  operation: 'update',
  resourceType: 'page',
  ...overrides,
});

// ============================================================================
// GET /api/activities/[activityId] - Contract Tests
// ============================================================================

describe('GET /api/activities/[activityId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(canUserViewPage).mockResolvedValue(true);
    vi.mocked(isUserDriveMember).mockResolvedValue(true);
    vi.mocked(getActivityById).mockResolvedValue(createActivity());
    vi.mocked(previewRollback).mockResolvedValue({
      action: 'rollback',
      canExecute: true,
      warnings: [],
    } as any);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request(`https://example.com/api/activities/${mockActivityId}`);
      const response = await GET(request, { params: mockParams });

      expect(response.status).toBe(401);
    });

    it('should call authenticateRequestWithOptions with correct auth options', async () => {
      const request = new Request(`https://example.com/api/activities/${mockActivityId}`);
      await GET(request, { params: mockParams });

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['session', 'mcp'], requireCSRF: false }
      );
    });
  });

  describe('validation', () => {
    it('should return 400 for invalid context query parameter', async () => {
      const request = new Request(`https://example.com/api/activities/${mockActivityId}?context=invalid`);
      const response = await GET(request, { params: mockParams });

      expect(response.status).toBe(400);
    });

    it('should default to page context when no context is provided', async () => {
      const request = new Request(`https://example.com/api/activities/${mockActivityId}`);
      const response = await GET(request, { params: mockParams });

      expect(response.status).toBe(200);
      expect(previewRollback).toHaveBeenCalledWith(
        mockActivityId,
        mockUserId,
        'page'
      );
    });
  });

  describe('not found', () => {
    it('should return 404 when activity does not exist', async () => {
      vi.mocked(getActivityById).mockResolvedValue(null);

      const request = new Request(`https://example.com/api/activities/${mockActivityId}`);
      const response = await GET(request, { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Activity not found');
    });
  });

  describe('authorization', () => {
    it('should return 403 when user cannot view page-associated activity', async () => {
      vi.mocked(canUserViewPage).mockResolvedValue(false);

      const request = new Request(`https://example.com/api/activities/${mockActivityId}`);
      const response = await GET(request, { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Unauthorized - you do not have access to this page');
    });

    it('should return 403 when user cannot view drive-associated activity', async () => {
      vi.mocked(getActivityById).mockResolvedValue(createActivity({ pageId: null, driveId: 'drive_1' }));
      vi.mocked(isUserDriveMember).mockResolvedValue(false);

      const request = new Request(`https://example.com/api/activities/${mockActivityId}`);
      const response = await GET(request, { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Unauthorized - you do not have access to this drive');
    });

    it('should return 403 when user-level activity belongs to another user', async () => {
      vi.mocked(getActivityById).mockResolvedValue(
        createActivity({ pageId: null, driveId: null, userId: 'other_user' })
      );

      const request = new Request(`https://example.com/api/activities/${mockActivityId}`);
      const response = await GET(request, { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Unauthorized - you do not have access to this activity');
    });

    it('should allow access to user-level activity owned by the user', async () => {
      vi.mocked(getActivityById).mockResolvedValue(
        createActivity({ pageId: null, driveId: null, userId: mockUserId })
      );

      const request = new Request(`https://example.com/api/activities/${mockActivityId}`);
      const response = await GET(request, { params: mockParams });

      expect(response.status).toBe(200);
    });
  });

  describe('success', () => {
    it('should return activity with rollback preview', async () => {
      const activity = createActivity();
      const preview = {
        action: 'rollback',
        canExecute: true,
        warnings: [],
      };
      vi.mocked(getActivityById).mockResolvedValue(activity);
      vi.mocked(previewRollback).mockResolvedValue(preview as any);

      const request = new Request(`https://example.com/api/activities/${mockActivityId}?context=page`);
      const response = await GET(request, { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.activity).toEqual(activity);
      expect(body.preview).toEqual(preview);
    });

    it('should pass correct context to previewRollback', async () => {
      const request = new Request(`https://example.com/api/activities/${mockActivityId}?context=drive`);
      await GET(request, { params: mockParams });

      expect(previewRollback).toHaveBeenCalledWith(
        mockActivityId,
        mockUserId,
        'drive'
      );
    });

    it('should await params correctly (Next.js 15 pattern)', async () => {
      const request = new Request(`https://example.com/api/activities/${mockActivityId}`);
      await GET(request, { params: mockParams });

      expect(getActivityById).toHaveBeenCalledWith(mockActivityId);
    });
  });
});
