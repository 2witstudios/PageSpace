/**
 * Contract tests for POST /api/activities/[activityId]/rollback
 *
 * Tests the route handler's contract:
 * - Authentication: 401 for unauthenticated requests
 * - Validation: 400 for invalid body, missing context
 * - Authorization: 400 when permission denied (from service)
 * - Success: 200 with rollback result
 * - Dry run: 200 with preview data
 */
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { NextResponse } from 'next/server';
import { POST } from '../route';
import type { WebAuthResult, AuthError } from '../../../../../../lib/auth';

// Mock service boundary
vi.mock('../../../../../../services/api', () => ({
  executeRollback: vi.fn(),
  previewRollback: vi.fn(),
  getActivityById: vi.fn(),
}));

// Mock auth
vi.mock('../../../../../../lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result) => 'error' in result),
}));

// Mock database for idempotency check
vi.mock('@pagespace/db', () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]), // No existing rollback by default
        }),
      }),
    }),
    transaction: vi.fn((callback: (tx: object) => Promise<unknown>) => callback({})),
  },
  activityLogs: { id: 'id', operation: 'operation', rollbackFromActivityId: 'rollbackFromActivityId' },
  eq: vi.fn(),
  and: vi.fn(),
}));

// Mock loggers
vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: {
      debug: vi.fn(),
    },
  },
}));

// Mock websocket broadcasts
vi.mock('../../../../../../lib/websocket', () => ({
  broadcastPageEvent: vi.fn(),
  createPageEventPayload: vi.fn(),
  broadcastDriveEvent: vi.fn(),
  createDriveEventPayload: vi.fn(),
  broadcastDriveMemberEvent: vi.fn(),
  createDriveMemberEventPayload: vi.fn(),
}));

// Mock mask utility
vi.mock('../../../../../../lib/logging/mask', () => ({
  maskIdentifier: vi.fn((id: string) => `***${id.slice(-4)}`),
}));

import { executeRollback, previewRollback } from '../../../../../../services/api';
import { authenticateRequestWithOptions } from '../../../../../../lib/auth';
import { db } from '@pagespace/db';

// Test helpers
const mockUserId = 'user_123';
const mockActivityId = 'activity_123';

const mockWebAuth = (userId: string): WebAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'jwt',
  source: 'cookie',
  role: 'user',
});

const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

const createRequest = (body: object) => {
  return new Request(`https://example.com/api/activities/${mockActivityId}/rollback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
};

const mockParams = Promise.resolve({ activityId: mockActivityId });

describe('POST /api/activities/[activityId]/rollback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (authenticateRequestWithOptions as Mock).mockResolvedValue(mockWebAuth(mockUserId));
  });

  // ============================================
  // Authentication
  // ============================================

  describe('authentication', () => {
    it('returns 401 when user is not authenticated', async () => {
      (authenticateRequestWithOptions as Mock).mockResolvedValue(mockAuthError(401));

      const response = await POST(createRequest({ context: 'page' }), { params: mockParams });

      expect(response.status).toBe(401);
      expect(executeRollback).not.toHaveBeenCalled();
    });

    it('requires CSRF token (auth options include requireCSRF: true)', async () => {
      // Mock a successful rollback so the request completes
      (executeRollback as Mock).mockResolvedValue({
        success: true,
        message: 'OK',
        warnings: [],
      });

      // Verify auth was called with CSRF requirement
      await POST(createRequest({ context: 'page' }), { params: mockParams });

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        expect.any(Request),
        expect.objectContaining({ requireCSRF: true })
      );
    });
  });

  // ============================================
  // Validation
  // ============================================

  describe('validation', () => {
    it('returns 400 for invalid JSON body', async () => {
      const request = new Request(`https://example.com/api/activities/${mockActivityId}/rollback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not valid json',
      });

      const response = await POST(request, { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid JSON body');
    });

    it('returns 400 when context is missing', async () => {
      const response = await POST(createRequest({}), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBeDefined();
    });

    it('returns 400 for invalid context value', async () => {
      const response = await POST(createRequest({ context: 'invalid_context' }), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBeDefined();
    });

    it('accepts valid context values', async () => {
      const validContexts = ['page', 'drive', 'ai_tool', 'user_dashboard'];

      for (const context of validContexts) {
        vi.clearAllMocks();
        (authenticateRequestWithOptions as Mock).mockResolvedValue(mockWebAuth(mockUserId));
        (executeRollback as Mock).mockResolvedValue({
          success: true,
          message: 'Rollback successful',
          warnings: [],
        });

        const response = await POST(createRequest({ context }), { params: mockParams });

        expect(response.status).toBe(200);
      }
    });
  });

  // ============================================
  // Dry run (preview)
  // ============================================

  describe('dry run', () => {
    it('returns preview when dryRun is true', async () => {
      const mockPreview = {
        activity: { id: mockActivityId },
        canRollback: true,
        currentValues: { title: 'Current' },
        rollbackToValues: { title: 'Previous' },
        warnings: [],
        affectedResources: [{ type: 'page', id: 'page_123', title: 'Test Page' }],
      };

      (previewRollback as Mock).mockResolvedValue(mockPreview);

      const response = await POST(
        createRequest({ context: 'page', dryRun: true }),
        { params: mockParams }
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.dryRun).toBe(true);
      expect(body.canRollback).toBe(true);
      expect(body.rollbackToValues).toEqual({ title: 'Previous' });
      expect(executeRollback).not.toHaveBeenCalled();
    });

    it('returns preview failure reason when cannot rollback', async () => {
      (previewRollback as Mock).mockResolvedValue({
        activity: null,
        canRollback: false,
        reason: 'Activity not found',
        currentValues: null,
        rollbackToValues: null,
        warnings: [],
        affectedResources: [],
      });

      const response = await POST(
        createRequest({ context: 'page', dryRun: true }),
        { params: mockParams }
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.dryRun).toBe(true);
      expect(body.canRollback).toBe(false);
      expect(body.reason).toBe('Activity not found');
    });
  });

  // ============================================
  // Execute rollback
  // ============================================

  describe('execute rollback', () => {
    it('returns success result when rollback succeeds', async () => {
      (executeRollback as Mock).mockResolvedValue({
        success: true,
        rollbackActivityId: 'rollback_activity_123',
        restoredValues: { title: 'Previous Title' },
        message: 'Successfully restored to previous state',
        warnings: [],
      });

      const response = await POST(createRequest({ context: 'page' }), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.message).toBe('Successfully restored to previous state');
      expect(body.restoredValues).toEqual({ title: 'Previous Title' });
    });

    it('returns 400 when rollback fails', async () => {
      (executeRollback as Mock).mockResolvedValue({
        success: false,
        message: 'You need edit permission to rollback changes to this page',
        warnings: [],
      });

      const response = await POST(createRequest({ context: 'page' }), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('You need edit permission to rollback changes to this page');
    });

    it('includes warnings in response', async () => {
      (executeRollback as Mock).mockResolvedValue({
        success: true,
        message: 'Rollback completed',
        warnings: ['Resource has been modified since this change'],
        restoredValues: {},
      });

      const response = await POST(createRequest({ context: 'page' }), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.warnings).toContain('Resource has been modified since this change');
    });

    it('passes correct parameters to service', async () => {
      (executeRollback as Mock).mockResolvedValue({
        success: true,
        message: 'OK',
        warnings: [],
      });

      await POST(createRequest({ context: 'drive' }), { params: mockParams });

      // Route now wraps executeRollback in transaction and passes options
      expect(executeRollback).toHaveBeenCalledWith(
        mockActivityId,
        mockUserId,
        'drive',
        expect.objectContaining({ tx: expect.any(Object), force: false })
      );
    });
  });

  // ============================================
  // Idempotency
  // ============================================

  describe('idempotency', () => {
    const existingRollbackId = 'existing_rollback_456';

    // Helper to mock db.select chain to return existing rollback
    const mockExistingRollback = () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: existingRollbackId }]),
          }),
        }),
      } as ReturnType<typeof db.select>);
    };

    // Helper to reset db mock to default (no existing rollback)
    const resetDbMock = () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as ReturnType<typeof db.select>);
    };

    afterEach(() => {
      resetDbMock();
    });

    it('returns existing rollback when activity was already rolled back', async () => {
      mockExistingRollback();

      const response = await POST(createRequest({ context: 'page' }), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.message).toBe('Already rolled back');
      expect(body.rollbackActivityId).toBe(existingRollbackId);
      expect(body.warnings).toEqual([]);
      expect(executeRollback).not.toHaveBeenCalled();
    });

    it('prevents duplicate rollbacks on double-click (both requests return same result)', async () => {
      mockExistingRollback();

      // Simulate double-click: two requests in quick succession
      const [response1, response2] = await Promise.all([
        POST(createRequest({ context: 'page' }), { params: mockParams }),
        POST(createRequest({ context: 'page' }), { params: mockParams }),
      ]);

      const body1 = await response1.json();
      const body2 = await response2.json();

      // Both should return the same existing rollback
      expect(response1.status).toBe(200);
      expect(response2.status).toBe(200);
      expect(body1.rollbackActivityId).toBe(existingRollbackId);
      expect(body2.rollbackActivityId).toBe(existingRollbackId);
      expect(body1.message).toBe('Already rolled back');
      expect(body2.message).toBe('Already rolled back');

      // executeRollback should never be called since both see existing rollback
      expect(executeRollback).not.toHaveBeenCalled();
    });
  });
});
