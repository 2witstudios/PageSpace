/**
 * Contract tests for GET /api/pages/[pageId]/history
 *
 * Tests the route handler's contract:
 * - Authentication: 401 for unauthenticated
 * - Authorization: 403 when user can't view page
 * - Validation: 400 for invalid query params
 * - Success: 200 with versions, pagination, and retention info
 * - Retention: Applies tier-based retention limits
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { GET } from '../route';
import type { SessionAuthResult, AuthError } from '../../../../../../lib/auth';

// Mock service boundary
vi.mock('../../../../../../services/api', () => ({
  getPageVersionHistory: vi.fn(),
  getUserRetentionDays: vi.fn(),
}));

// Mock auth
vi.mock('../../../../../../lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result) => 'error' in result),
  checkMCPPageScope: vi.fn().mockResolvedValue(null),
}));

// Mock permissions
vi.mock('@pagespace/lib', () => ({
  canUserViewPage: vi.fn(),
}));

// Mock the permission helper from lib/permissions
vi.mock('@pagespace/lib/permissions', () => ({
  isActivityEligibleForRollback: vi.fn(),
}));

import { getPageVersionHistory, getUserRetentionDays } from '../../../../../../services/api';
import { authenticateRequestWithOptions } from '../../../../../../lib/auth';
import { canUserViewPage } from '@pagespace/lib';
import { isActivityEligibleForRollback } from '@pagespace/lib/permissions';

// Test helpers
const mockUserId = 'user_123';
const mockPageId = 'page_123';

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

const createRequest = (queryParams: Record<string, string> = {}) => {
  const url = new URL(`https://example.com/api/pages/${mockPageId}/history`);
  Object.entries(queryParams).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });
  return new Request(url.toString(), { method: 'GET' });
};

const mockParams = Promise.resolve({ pageId: mockPageId });

const createMockActivity = (overrides = {}) => ({
  id: 'activity_123',
  timestamp: new Date('2024-01-15T10:00:00Z'),
  userId: mockUserId,
  actorEmail: 'test@example.com',
  actorDisplayName: 'Test User',
  operation: 'update',
  resourceType: 'page',
  resourceId: mockPageId,
  resourceTitle: 'Test Page',
  driveId: 'drive_123',
  pageId: mockPageId,
  isAiGenerated: false,
  previousValues: { title: 'Old' },
  newValues: { title: 'New' },
  contentSnapshot: null,
  ...overrides,
});

describe('GET /api/pages/[pageId]/history', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Use fake timers to ensure deterministic date comparisons in retention tests
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T12:00:00Z'));
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(canUserViewPage).mockResolvedValue(true);
    vi.mocked(getUserRetentionDays).mockResolvedValue(30);
    vi.mocked(getPageVersionHistory).mockResolvedValue({
      activities: [],
      total: 0,
    });
    vi.mocked(isActivityEligibleForRollback).mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ============================================
  // Authentication
  // ============================================

  describe('authentication', () => {
    it('returns 401 when user is not authenticated', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const response = await GET(createRequest(), { params: mockParams });

      expect(response.status).toBe(401);
      expect(getPageVersionHistory).not.toHaveBeenCalled();
    });

    it('allows session and MCP auth', async () => {
      const request = createRequest();
      await GET(request, { params: mockParams });

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['session', 'mcp'], requireCSRF: false }
      );
    });
  });

  // ============================================
  // Authorization
  // ============================================

  describe('authorization', () => {
    it('returns 403 when user cannot view page', async () => {
      vi.mocked(canUserViewPage).mockResolvedValue(false);

      const response = await GET(createRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toContain('do not have access');
    });
  });

  // ============================================
  // Query parameter validation
  // ============================================

  describe('query parameters', () => {
    it('uses default limit of 50', async () => {
      vi.mocked(getPageVersionHistory).mockResolvedValue({
        activities: [],
        total: 0,
      });

      await GET(createRequest(), { params: mockParams });

      expect(getPageVersionHistory).toHaveBeenCalledWith(
        mockPageId,
        mockUserId,
        expect.objectContaining({ limit: 50 })
      );
    });

    it('uses default offset of 0', async () => {
      await GET(createRequest(), { params: mockParams });

      expect(getPageVersionHistory).toHaveBeenCalledWith(
        mockPageId,
        mockUserId,
        expect.objectContaining({ offset: 0 })
      );
    });

    it('accepts custom limit and offset', async () => {
      await GET(createRequest({ limit: '20', offset: '10' }), { params: mockParams });

      expect(getPageVersionHistory).toHaveBeenCalledWith(
        mockPageId,
        mockUserId,
        expect.objectContaining({ limit: 20, offset: 10 })
      );
    });

    it('returns 400 for limit over 100', async () => {
      const response = await GET(createRequest({ limit: '101' }), { params: mockParams });

      expect(response.status).toBe(400);
    });

    it('returns 400 for negative offset', async () => {
      const response = await GET(createRequest({ offset: '-1' }), { params: mockParams });

      expect(response.status).toBe(400);
    });

    it('accepts date filters', async () => {
      await GET(
        createRequest({
          startDate: '2024-01-01',
          endDate: '2024-12-31',
        }),
        { params: mockParams }
      );

      // startDate '2024-01-01' is before the 30-day retention cutoff,
      // so the route clamps it to the retention boundary (2024-06-15 minus 30 days)
      const retentionCutoff = new Date('2024-06-15T12:00:00Z');
      retentionCutoff.setDate(retentionCutoff.getDate() - 30);

      expect(getPageVersionHistory).toHaveBeenCalledWith(
        mockPageId,
        mockUserId,
        expect.objectContaining({
          startDate: retentionCutoff,
          endDate: new Date('2024-12-31'),
        })
      );
    });

    it('accepts actorId filter', async () => {
      await GET(createRequest({ actorId: 'actor_456' }), { params: mockParams });

      expect(getPageVersionHistory).toHaveBeenCalledWith(
        mockPageId,
        mockUserId,
        expect.objectContaining({ actorId: 'actor_456' })
      );
    });

    it('accepts operation filter', async () => {
      await GET(createRequest({ operation: 'update' }), { params: mockParams });

      expect(getPageVersionHistory).toHaveBeenCalledWith(
        mockPageId,
        mockUserId,
        expect.objectContaining({ operation: 'update' })
      );
    });

    it('accepts includeAiOnly filter', async () => {
      await GET(createRequest({ includeAiOnly: 'true' }), { params: mockParams });

      expect(getPageVersionHistory).toHaveBeenCalledWith(
        mockPageId,
        mockUserId,
        expect.objectContaining({ includeAiOnly: true })
      );
    });
  });

  // ============================================
  // Retention enforcement
  // ============================================

  describe('retention', () => {
    it('applies retention limit to startDate for free tier (7 days)', async () => {
      vi.mocked(getUserRetentionDays).mockResolvedValue(7);

      await GET(createRequest(), { params: mockParams });

      // Should have called with a startDate exactly 7 days ago
      const call = vi.mocked(getPageVersionHistory).mock.calls[0];
      const options = call[2]!;

      expect(options.startDate).toBeInstanceOf(Date);
      const daysDiff = Math.floor(
        (Date.now() - options.startDate!.getTime()) / (1000 * 60 * 60 * 24)
      );
      expect(daysDiff).toBeLessThanOrEqual(7);
    });

    it('applies retention limit to startDate for pro tier (30 days)', async () => {
      vi.mocked(getUserRetentionDays).mockResolvedValue(30);

      await GET(createRequest(), { params: mockParams });

      const call = vi.mocked(getPageVersionHistory).mock.calls[0];
      const options = call[2]!;

      expect(options.startDate).toBeInstanceOf(Date);
      const daysDiff = Math.floor(
        (Date.now() - options.startDate!.getTime()) / (1000 * 60 * 60 * 24)
      );
      expect(daysDiff).toBeLessThanOrEqual(30);
    });

    it('does not limit startDate for unlimited tier (-1)', async () => {
      vi.mocked(getUserRetentionDays).mockResolvedValue(-1);

      await GET(createRequest(), { params: mockParams });

      const call = vi.mocked(getPageVersionHistory).mock.calls[0];
      const options = call[2]!;

      // Should not have an effective start date when unlimited
      expect(options.startDate).toBeUndefined();
    });

    it('respects user-provided startDate if within retention', async () => {
      vi.mocked(getUserRetentionDays).mockResolvedValue(30);

      // Request history from 10 days ago (within 30 day retention)
      const tenDaysAgo = new Date();
      tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);

      await GET(
        createRequest({ startDate: tenDaysAgo.toISOString() }),
        { params: mockParams }
      );

      const call = vi.mocked(getPageVersionHistory).mock.calls[0];
      const options = call[2]!;

      // Should use user-provided date since it's within retention
      const daysDiff = Math.floor(
        (Date.now() - options.startDate!.getTime()) / (1000 * 60 * 60 * 24)
      );
      expect(daysDiff).toBeGreaterThanOrEqual(9);
      expect(daysDiff).toBeLessThanOrEqual(11);
    });

    it('clamps startDate to retention limit if user requests beyond', async () => {
      vi.mocked(getUserRetentionDays).mockResolvedValue(7);

      // Request history from 30 days ago (beyond 7 day retention)
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      await GET(
        createRequest({ startDate: thirtyDaysAgo.toISOString() }),
        { params: mockParams }
      );

      const call = vi.mocked(getPageVersionHistory).mock.calls[0];
      const options = call[2]!;

      // Should clamp to retention limit
      const daysDiff = Math.floor(
        (Date.now() - options.startDate!.getTime()) / (1000 * 60 * 60 * 24)
      );
      expect(daysDiff).toBeLessThanOrEqual(7);
    });

    it('includes retentionDays in response', async () => {
      vi.mocked(getUserRetentionDays).mockResolvedValue(30);
      vi.mocked(getPageVersionHistory).mockResolvedValue({
        activities: [],
        total: 0,
      });

      const response = await GET(createRequest(), { params: mockParams });
      const body = await response.json();

      expect(body.retentionDays).toBe(30);
    });
  });

  // ============================================
  // Response format
  // ============================================

  describe('response format', () => {
    it('returns versions with canRollback flag', async () => {
      const mockActivities = [
        createMockActivity({ id: 'act_1', operation: 'update' }),
        createMockActivity({ id: 'act_2', operation: 'create' }),
      ];

      vi.mocked(getPageVersionHistory).mockResolvedValue({
        activities: mockActivities,
        total: 2,
      } as never);

      vi.mocked(isActivityEligibleForRollback)
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(false);

      const response = await GET(createRequest(), { params: mockParams });
      const body = await response.json();

      expect(body.versions).toHaveLength(2);
      expect(body.versions[0].canRollback).toBe(true);
      expect(body.versions[1].canRollback).toBe(false);
    });

    it('includes pagination metadata', async () => {
      vi.mocked(getPageVersionHistory).mockResolvedValue({
        activities: [createMockActivity()],
        total: 100,
      } as never);

      const response = await GET(createRequest({ limit: '10', offset: '20' }), { params: mockParams });
      const body = await response.json();

      expect(body.pagination).toEqual({
        total: 100,
        limit: 10,
        offset: 20,
        hasMore: true,
      });
    });

    it('hasMore is false when at end', async () => {
      vi.mocked(getPageVersionHistory).mockResolvedValue({
        activities: [createMockActivity()],
        total: 21,
      } as never);

      const response = await GET(createRequest({ limit: '10', offset: '20' }), { params: mockParams });
      const body = await response.json();

      expect(body.pagination.hasMore).toBe(false);
    });
  });
});
