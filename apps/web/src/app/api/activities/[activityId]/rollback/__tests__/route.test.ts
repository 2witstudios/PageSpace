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
import type { SessionAuthResult, AuthError } from '../../../../../../lib/auth';
import type { ActivityActionPreview } from '../../../../../../types/activity-actions';

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

// Test helpers
const mockUserId = 'user_123';
const mockActivityId = 'activity_123';

const createMockPreview = (overrides: Partial<ActivityActionPreview> = {}): ActivityActionPreview => ({
  action: 'rollback',
  canExecute: true,
  reason: undefined,
  warnings: [],
  hasConflict: false,
  conflictFields: [],
  requiresForce: false,
  isNoOp: false,
  currentValues: null,
  targetValues: null,
  changes: [],
  affectedResources: [],
  ...overrides,
});

const mockWebAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session-id',
  
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
      const mockPreview = createMockPreview({
        canExecute: true,
        currentValues: { title: 'Current' },
        targetValues: { title: 'Previous' },
        changes: [
          {
            id: mockActivityId,
            label: 'Undo Update',
            description: 'Test Page',
            fields: ['title'],
          },
        ],
        affectedResources: [{ type: 'page', id: 'page_123', title: 'Test Page' }],
      });

      (previewRollback as Mock).mockResolvedValue(mockPreview);

      const response = await POST(
        createRequest({ context: 'page', dryRun: true }),
        { params: mockParams }
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.preview).toEqual(mockPreview);
      expect(executeRollback).not.toHaveBeenCalled();
    });

    it('returns preview failure reason when cannot rollback', async () => {
      (previewRollback as Mock).mockResolvedValue(
        createMockPreview({
          canExecute: false,
          reason: 'Activity not found',
        })
      );

      const response = await POST(
        createRequest({ context: 'page', dryRun: true }),
        { params: mockParams }
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.preview.canExecute).toBe(false);
      expect(body.preview.reason).toBe('Activity not found');
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
        message: 'Change undone',
        warnings: [],
      });

      const response = await POST(createRequest({ context: 'page' }), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.message).toBe('Change undone');
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

});
