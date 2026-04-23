/**
 * Contract tests for POST /api/pages/[pageId]/restore
 *
 * These tests verify the route handler's contract:
 * - Authentication and authorization checks
 * - MCP scope checking
 * - Page restoration logic (recursive restore with children)
 * - Side effects: broadcasts, cache invalidation, activity tracking
 * - Error handling
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError, MCPAuthResult } from '@/lib/auth';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const {
  mockApplyPageMutation,
  mockAuthenticateRequest,
  mockIsAuthError,
  mockIsMCPAuthResult,
  mockCheckMCPPageScope,
  mockBroadcastPageEvent,
  mockCreatePageEventPayload,
  mockPagesFindFirst,
  mockTransaction,
  mockTrackPageOperation,
  mockGetActorInfo,
  mockCreateChangeGroupId,
  mockInferChangeGroupType,
  mockLoggers,
} = vi.hoisted(() => ({
  mockApplyPageMutation: vi.fn(),
  mockAuthenticateRequest: vi.fn(),
  mockIsAuthError: vi.fn((result: unknown) => result != null && typeof result === 'object' && 'error' in result),
  mockIsMCPAuthResult: vi.fn().mockReturnValue(false),
  mockCheckMCPPageScope: vi.fn().mockResolvedValue(null),
  mockBroadcastPageEvent: vi.fn(),
  mockCreatePageEventPayload: vi.fn((driveId: string, pageId: string, type: string, data: Record<string, unknown>) => ({
    driveId, pageId, type, ...data,
  })),
  mockPagesFindFirst: vi.fn(),
  mockTransaction: vi.fn(),
  mockTrackPageOperation: vi.fn(),
  mockGetActorInfo: vi.fn().mockResolvedValue({
    actorEmail: 'test@example.com',
    actorDisplayName: 'Test User',
  }),
  mockCreateChangeGroupId: vi.fn().mockReturnValue('cg-123'),
  mockInferChangeGroupType: vi.fn().mockReturnValue('user'),
  mockLoggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

// ── vi.mock declarations ───────────────────────────────────────────────────

vi.mock('@/services/api/page-mutation-service', () => ({
  applyPageMutation: (...args: unknown[]) => mockApplyPageMutation(...args),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: (...args: unknown[]) => mockAuthenticateRequest(...args),
  isAuthError: (result: unknown) => mockIsAuthError(result),
  isMCPAuthResult: (result: unknown) => mockIsMCPAuthResult(result),
  checkMCPPageScope: (...args: unknown[]) => mockCheckMCPPageScope(...args),
}));

vi.mock('@/lib/websocket', () => ({
  broadcastPageEvent: (...args: unknown[]) => mockBroadcastPageEvent(...args),
  // @ts-expect-error - test mock spread
  createPageEventPayload: (...args: unknown[]) => mockCreatePageEventPayload(...args),
}));

vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      pages: {
        findFirst: (...args: unknown[]) => mockPagesFindFirst(...args),
      },
    },
    transaction: (...args: unknown[]) => mockTransaction(...args),
  },
  pages: {
    id: 'id',
    parentId: 'parentId',
    isTrashed: 'isTrashed',
    revision: 'revision',
    originalParentId: 'originalParentId',
  },
  and: vi.fn(),
  eq: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: mockLoggers,
  getActorInfo: (...args: unknown[]) => mockGetActorInfo(...args),
  auditRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/monitoring/activity-tracker', () => ({
  trackPageOperation: (...args: unknown[]) => mockTrackPageOperation(...args),
}));

vi.mock('@pagespace/lib/monitoring', () => ({
  createChangeGroupId: () => mockCreateChangeGroupId(),
  inferChangeGroupType: (...args: unknown[]) => mockInferChangeGroupType(...args),
}));

// ── Imports (after mocks) ──────────────────────────────────────────────────

import { POST } from '../../restore/route';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

// ── Helpers ────────────────────────────────────────────────────────────────

const mockUserId = 'user_123';
const mockPageId = 'page_123';
const mockDriveId = 'drive_123';

const mockWebAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session-id',
  role: 'user',
  adminRoleVersion: 0,
});

const mockMCPAuth = (userId: string): MCPAuthResult => ({
  userId,
  tokenType: 'mcp',
  tokenVersion: 0,
  tokenId: 'mcp-token-id',
  // @ts-expect-error - test mock with extra properties
  scopes: ['page:write'],
  driveIds: [mockDriveId],
  pageIds: [mockPageId],
});

const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

const createRequest = () =>
  new Request(`https://example.com/api/pages/${mockPageId}/restore`, {
    method: 'POST',
  });

const mockParams = { params: Promise.resolve({ pageId: mockPageId }) };

const mockTrashedPage = {
  id: mockPageId,
  title: 'Trashed Page',
  type: 'DOCUMENT',
  parentId: 'parent_123',
  driveId: mockDriveId,
  isTrashed: true,
  drive: { id: mockDriveId },
};

/**
 * Helper: sets up mockTransaction to simulate recursivelyRestore behavior.
 *
 * The recursivelyRestore function makes 3 queries per page:
 *   1. Revision lookup (with .limit)
 *   2. Children query (returns array)
 *   3. Orphaned children query (returns array)
 *
 * IMPORTANT: recursion happens BETWEEN query 2 (children) and query 3 (orphans).
 * So if there is 1 child, the actual call order is:
 *   1: parent revision, 2: parent children -> [child],
 *   3: child revision, 4: child children, 5: child orphans,
 *   6: parent orphans
 */
function setupTransaction(opts: {
  revisionResult?: unknown[];
  childrenResult?: unknown[];
  orphanResult?: unknown[];
  childRevisionResult?: unknown[];
} = {}) {
  const {
    revisionResult = [{ revision: 1 }],
    childrenResult = [],
    orphanResult = [],
    childRevisionResult = [{ revision: 2 }],
  } = opts;

  // Build the expected sequence of where() results based on whether there are children
  const hasChildren = childrenResult.length > 0;

  mockTransaction.mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
    let whereCallCount = 0;

    // Build sequence dynamically:
    // Parent: revision(.limit), children, [child recursion...], orphans
    // Each child: revision(.limit), children, orphans
    const sequence: Array<{ hasLimit: boolean; result: unknown }> = [];

    // Parent queries
    sequence.push({ hasLimit: true, result: revisionResult }); // 1: parent revision
    sequence.push({ hasLimit: false, result: childrenResult }); // 2: parent children

    // If there are children, insert child queries between parent children and parent orphans
    if (hasChildren) {
      for (let i = 0; i < childrenResult.length; i++) {
        sequence.push({ hasLimit: true, result: childRevisionResult }); // child revision
        sequence.push({ hasLimit: false, result: [] }); // child children (no grandchildren)
        sequence.push({ hasLimit: false, result: [] }); // child orphans
      }
    }

    sequence.push({ hasLimit: false, result: orphanResult }); // last: parent orphans

    const whereFn = vi.fn().mockImplementation(() => {
      const entry = sequence[whereCallCount] || { hasLimit: false, result: [] };
      whereCallCount++;
      if (entry.hasLimit) {
        return { limit: vi.fn().mockResolvedValue(entry.result) };
      }
      return Promise.resolve(entry.result);
    });

    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });
    await cb({ select: selectFn });
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('POST /api/pages/[pageId]/restore', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockAuthenticateRequest.mockResolvedValue(mockWebAuth(mockUserId));
    mockIsAuthError.mockImplementation((result: unknown) => result != null && typeof result === 'object' && 'error' in result);
    mockIsMCPAuthResult.mockReturnValue(false);
    mockCheckMCPPageScope.mockResolvedValue(null);
    mockPagesFindFirst.mockResolvedValue(mockTrashedPage);
    mockApplyPageMutation.mockResolvedValue({ deferredTrigger: null });
    mockGetActorInfo.mockResolvedValue({
      actorEmail: 'test@example.com',
      actorDisplayName: 'Test User',
    });
    mockCreateChangeGroupId.mockReturnValue('cg-123');
    mockInferChangeGroupType.mockReturnValue('user');
    vi.mocked(auditRequest).mockReturnValue(undefined);
    setupTransaction();
  });

  describe('authentication', () => {
    it('returns 401 when user is not authenticated', async () => {
      mockAuthenticateRequest.mockResolvedValue(mockAuthError(401));

      const response = await POST(createRequest(), mockParams);

      expect(response.status).toBe(401);
    });
  });

  describe('MCP scope checking', () => {
    it('returns scope error when MCP token lacks page scope', async () => {
      mockCheckMCPPageScope.mockResolvedValue(
        NextResponse.json({ error: 'Scope denied' }, { status: 403 })
      );

      const response = await POST(createRequest(), mockParams);

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe('Scope denied');
    });
  });

  describe('page validation', () => {
    it('returns 400 when page is not found', async () => {
      mockPagesFindFirst.mockResolvedValue(null);

      const response = await POST(createRequest(), mockParams);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toMatch(/not in trash/i);
    });

    it('returns 400 when page is not trashed', async () => {
      mockPagesFindFirst.mockResolvedValue({
        ...mockTrashedPage,
        isTrashed: false,
      });

      const response = await POST(createRequest(), mockParams);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toMatch(/not in trash/i);
    });
  });

  describe('successful restoration', () => {
    it('returns 200 with success message', async () => {
      const response = await POST(createRequest(), mockParams);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.message).toMatch(/restored/i);
    });

    it('fires deferred triggers after transaction', async () => {
      const deferredFn = vi.fn();
      mockApplyPageMutation.mockResolvedValue({ deferredTrigger: deferredFn });

      await POST(createRequest(), mockParams);

      expect(deferredFn).toHaveBeenCalledTimes(1);
    });

    it('includes MCP metadata when authenticated via MCP', async () => {
      mockAuthenticateRequest.mockResolvedValue(mockMCPAuth(mockUserId));
      mockIsMCPAuthResult.mockReturnValue(true);

      await POST(createRequest(), mockParams);

      expect(mockApplyPageMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          context: expect.objectContaining({
            metadata: { source: 'mcp' },
          }),
        })
      );
    });

    it('passes undefined metadata when not MCP', async () => {
      await POST(createRequest(), mockParams);

      expect(mockApplyPageMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          context: expect.objectContaining({
            metadata: undefined,
          }),
        })
      );
    });
  });

  describe('recursive restore with children', () => {
    it('restores trashed children recursively', async () => {
      setupTransaction({ childrenResult: [{ id: 'child_1' }] });

      const response = await POST(createRequest(), mockParams);

      expect(response.status).toBe(200);
      // Parent restore + child restore = 2 calls
      expect(mockApplyPageMutation).toHaveBeenCalledTimes(2);
    });

    it('reparents orphaned children back to restored page', async () => {
      setupTransaction({ orphanResult: [{ id: 'orphan_1', revision: 3 }] });

      const response = await POST(createRequest(), mockParams);

      expect(response.status).toBe(200);
      // 1 restore + 1 move for orphan = 2 calls
      expect(mockApplyPageMutation).toHaveBeenCalledTimes(2);
      expect(mockApplyPageMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'move',
          updates: { parentId: mockPageId, originalParentId: null },
        })
      );
    });

    it('returns empty triggers when page not found in transaction', async () => {
      setupTransaction({ revisionResult: [] });

      const response = await POST(createRequest(), mockParams);

      expect(response.status).toBe(200);
      expect(mockApplyPageMutation).not.toHaveBeenCalled();
    });
  });

  describe('side effects', () => {
    it('broadcasts page restored event when drive exists', async () => {
      await POST(createRequest(), mockParams);

      expect(mockCreatePageEventPayload).toHaveBeenCalledWith(
        mockDriveId,
        mockPageId,
        'restored',
        expect.objectContaining({
          title: 'Trashed Page',
          parentId: 'parent_123',
          type: 'DOCUMENT',
        })
      );
      expect(mockBroadcastPageEvent).toHaveBeenCalledTimes(1);
    });

    it('does not broadcast when page has no drive', async () => {
      mockPagesFindFirst.mockResolvedValue({
        ...mockTrashedPage,
        drive: null,
      });

      await POST(createRequest(), mockParams);

      expect(mockBroadcastPageEvent).not.toHaveBeenCalled();
    });

    it('tracks page operation', async () => {
      await POST(createRequest(), mockParams);

      expect(mockTrackPageOperation).toHaveBeenCalledWith(
        mockUserId,
        'restore',
        mockPageId,
        expect.objectContaining({
          pageTitle: 'Trashed Page',
          pageType: 'DOCUMENT',
        })
      );
    });

  });

  describe('error handling', () => {
    it('returns 500 with error message when an Error is thrown', async () => {
      mockPagesFindFirst.mockRejectedValueOnce(new Error('Database error'));

      const response = await POST(createRequest(), mockParams);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Database error');
    });

    it('returns generic error message for non-Error exceptions', async () => {
      mockPagesFindFirst.mockRejectedValueOnce('string error');

      const response = await POST(createRequest(), mockParams);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to restore page');
    });
  });
});
