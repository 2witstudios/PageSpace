/**
 * Contract tests for POST /api/pages/bulk-move
 *
 * These tests verify the route handler's contract:
 * - Authentication and authorization checks
 * - Request validation via Zod schema
 * - MCP token scope checks for source and target drives
 * - Drive/page existence validation
 * - Permission checks (edit source, edit target drive)
 * - Circular reference validation
 * - Recursive driveId update for cross-drive moves
 * - Side effects: cache invalidation, broadcast, activity logging
 * - Error handling
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ── Mocks (before imports) ──────────────────────────────────────────────

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result: unknown) => result !== null && typeof result === 'object' && 'error' in (result as Record<string, unknown>)),
  checkMCPDriveScope: vi.fn(() => null),
  getAllowedDriveIds: vi.fn(() => []),
  isMCPAuthResult: vi.fn(() => false),
}));

vi.mock('@/lib/websocket', () => ({
  broadcastPageEvent: vi.fn().mockResolvedValue(undefined),
  createPageEventPayload: vi.fn((driveId: string, pageId: string, type: string) => ({
    driveId, pageId, type,
  })),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
  pageTreeCache: {
    invalidateDriveTree: vi.fn().mockResolvedValue(undefined),
  },
  canUserEditPage: vi.fn().mockResolvedValue(true),
}));

vi.mock('@pagespace/lib/pages/circular-reference-guard', () => ({
  validatePageMove: vi.fn().mockResolvedValue({ valid: true }),
}));

vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  getActorInfo: vi.fn().mockResolvedValue({ actorEmail: 'test@example.com', actorDisplayName: 'Test User' }),
  logPageActivity: vi.fn(),
}));

vi.mock('@pagespace/lib/monitoring', () => ({
  createChangeGroupId: vi.fn(() => 'change-group-123'),
}));

vi.mock('@pagespace/db', () => {
  const txUpdateWhere = vi.fn().mockResolvedValue(undefined);
  const txUpdateSet = vi.fn().mockReturnValue({ where: txUpdateWhere });
  const txUpdate = vi.fn().mockReturnValue({ set: txUpdateSet });
  const txQueryPagesFindMany = vi.fn().mockResolvedValue([]);
  const tx = {
    update: txUpdate,
    query: { pages: { findMany: txQueryPagesFindMany } },
  };
  const transaction = vi.fn(async (fn: (t: unknown) => Promise<void>) => {
    await fn(tx);
  });

  return {
    db: {
      query: {
        drives: { findFirst: vi.fn() },
        driveMembers: { findFirst: vi.fn() },
        pages: { findFirst: vi.fn(), findMany: vi.fn() },
      },
      transaction,
    },
    __test__: { txUpdate, txUpdateSet, txUpdateWhere, txQueryPagesFindMany, transaction },
    pages: { id: 'id', driveId: 'driveId', parentId: 'parentId', position: 'position', isTrashed: 'isTrashed' },
    drives: { id: 'id' },
    driveMembers: { driveId: 'driveId', userId: 'userId' },
    and: vi.fn((...args: unknown[]) => args),
    eq: vi.fn((a: unknown, b: unknown) => [a, b]),
    inArray: vi.fn((a: unknown, b: unknown) => [a, b]),
    desc: vi.fn((a: unknown) => a),
    isNull: vi.fn((a: unknown) => a),
  };
});

// ── Imports (after mocks) ───────────────────────────────────────────────

import { POST } from '../route';
import { authenticateRequestWithOptions, checkMCPDriveScope, getAllowedDriveIds, isMCPAuthResult } from '@/lib/auth';
import { broadcastPageEvent } from '@/lib/websocket';
import { pageTreeCache, canUserEditPage } from '@pagespace/lib/server';
import { validatePageMove } from '@pagespace/lib/pages/circular-reference-guard';
import { logPageActivity } from '@pagespace/lib/monitoring/activity-logger';
// @ts-expect-error - accessing test-only export
import { db, __test__ as dbTest } from '@pagespace/db';

const { txUpdate, txUpdateSet, txQueryPagesFindMany, transaction: mockTransaction } = dbTest as {
  txUpdate: ReturnType<typeof vi.fn>;
  txUpdateSet: ReturnType<typeof vi.fn>;
  txQueryPagesFindMany: ReturnType<typeof vi.fn>;
  transaction: ReturnType<typeof vi.fn>;
};

// ── Helpers ─────────────────────────────────────────────────────────────

const mockUserId = 'user_123';
const mockTargetDriveId = 'drive_target';
const mockSourceDriveId = 'drive_source';

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

const createRequest = (body: Record<string, unknown>) =>
  new Request('https://example.com/api/pages/bulk-move', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const mockSourcePage = (overrides = {}) => ({
  id: 'page-1',
  title: 'Source Page',
  type: 'DOCUMENT',
  driveId: mockSourceDriveId,
  parentId: null,
  position: 1,
  isTrashed: false,
  ...overrides,
});

const validBody = {
  pageIds: ['page-1'],
  targetDriveId: mockTargetDriveId,
  targetParentId: null,
};

function setupSuccessScenario() {
  // Auth
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
  vi.mocked(checkMCPDriveScope).mockReturnValue(null);
  vi.mocked(getAllowedDriveIds).mockReturnValue([]);
  vi.mocked(isMCPAuthResult).mockReturnValue(false);

  // DB queries
  vi.mocked(db.query.drives.findFirst).mockResolvedValue({ id: mockTargetDriveId, ownerId: mockUserId } as never);
  vi.mocked(db.query.driveMembers.findFirst).mockResolvedValue(undefined as never);
  vi.mocked(db.query.pages.findMany).mockResolvedValue([mockSourcePage()] as never);
  vi.mocked(db.query.pages.findFirst).mockResolvedValue({ position: 5 } as never);

  // Permissions
  vi.mocked(canUserEditPage).mockResolvedValue(true);
  vi.mocked(validatePageMove).mockResolvedValue({ valid: true });

  // Caches
  vi.mocked(pageTreeCache.invalidateDriveTree).mockResolvedValue(undefined);

  // Transaction mocks
  const txUpdateWhere = vi.fn().mockResolvedValue(undefined);
  txUpdateSet.mockReturnValue({ where: txUpdateWhere });
  txUpdate.mockReturnValue({ set: txUpdateSet });
  txQueryPagesFindMany.mockResolvedValue([]);
  mockTransaction.mockImplementation(async (fn: (t: unknown) => Promise<void>) => {
    await fn({
      update: txUpdate,
      query: { pages: { findMany: txQueryPagesFindMany } },
    });
  });
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('POST /api/pages/bulk-move', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupSuccessScenario();
  });

  // ── Authentication ──────────────────────────────────────────────────

  describe('authentication', () => {
    it('returns auth error when user is not authenticated', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const response = await POST(createRequest(validBody));

      expect(response.status).toBe(401);
    });
  });

  // ── Validation ──────────────────────────────────────────────────────

  describe('validation', () => {
    it('returns 400 when pageIds is empty', async () => {
      const response = await POST(createRequest({ ...validBody, pageIds: [] }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBeDefined();
    });

    it('returns 400 when pageIds is missing', async () => {
      const response = await POST(createRequest({ targetDriveId: mockTargetDriveId, targetParentId: null }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBeDefined();
    });

    it('returns 400 when targetDriveId is missing', async () => {
      const response = await POST(createRequest({ pageIds: ['page-1'], targetParentId: null }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBeDefined();
    });

    it('returns 400 when targetDriveId is empty string', async () => {
      const response = await POST(createRequest({ pageIds: ['page-1'], targetDriveId: '', targetParentId: null }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBeDefined();
    });
  });

  // ── Target drive checks ─────────────────────────────────────────────

  describe('target drive validation', () => {
    it('returns 404 when target drive does not exist', async () => {
      vi.mocked(db.query.drives.findFirst).mockResolvedValue(undefined as never);

      const response = await POST(createRequest(validBody));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toMatch(/target drive not found/i);
    });

    it('returns MCP scope error when token lacks target drive access', async () => {
      vi.mocked(checkMCPDriveScope).mockReturnValue(
        NextResponse.json({ error: 'Token scope error' }, { status: 403 })
      );

      const response = await POST(createRequest(validBody));

      expect(response.status).toBe(403);
    });
  });

  // ── Target drive permission ─────────────────────────────────────────

  describe('target drive permission', () => {
    it('allows when user is drive owner', async () => {
      const response = await POST(createRequest(validBody));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });

    it('allows when user is drive ADMIN member', async () => {
      vi.mocked(db.query.drives.findFirst).mockResolvedValue({ id: mockTargetDriveId, ownerId: 'other-user' } as never);
      vi.mocked(db.query.driveMembers.findFirst).mockResolvedValue({ role: 'ADMIN' } as never);

      const response = await POST(createRequest(validBody));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });

    it('allows when user is drive OWNER member', async () => {
      vi.mocked(db.query.drives.findFirst).mockResolvedValue({ id: mockTargetDriveId, ownerId: 'other-user' } as never);
      vi.mocked(db.query.driveMembers.findFirst).mockResolvedValue({ role: 'OWNER' } as never);

      const response = await POST(createRequest(validBody));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });

    it('returns 403 when user is only a VIEWER member', async () => {
      vi.mocked(db.query.drives.findFirst).mockResolvedValue({ id: mockTargetDriveId, ownerId: 'other-user' } as never);
      vi.mocked(db.query.driveMembers.findFirst).mockResolvedValue({ role: 'VIEWER' } as never);

      const response = await POST(createRequest(validBody));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toMatch(/permission.*move/i);
    });

    it('returns 403 when user has no membership', async () => {
      vi.mocked(db.query.drives.findFirst).mockResolvedValue({ id: mockTargetDriveId, ownerId: 'other-user' } as never);
      vi.mocked(db.query.driveMembers.findFirst).mockResolvedValue(undefined as never);

      const response = await POST(createRequest(validBody));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toMatch(/permission.*move/i);
    });
  });

  // ── Target parent validation ────────────────────────────────────────

  describe('target parent validation', () => {
    it('returns 404 when target parent does not exist', async () => {
      vi.mocked(db.query.pages.findFirst).mockResolvedValue(undefined as never);

      const response = await POST(createRequest({ ...validBody, targetParentId: 'nonexistent-parent' }));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toMatch(/target folder not found/i);
    });

    it('skips parent check when targetParentId is null', async () => {
      const response = await POST(createRequest({ ...validBody, targetParentId: null }));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });
  });

  // ── Source pages validation ─────────────────────────────────────────

  describe('source pages validation', () => {
    it('returns 404 when some source pages not found', async () => {
      vi.mocked(db.query.pages.findMany).mockResolvedValue([] as never);

      const response = await POST(createRequest(validBody));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toMatch(/some pages not found/i);
    });

    it('returns 403 when MCP token does not have access to source page drive', async () => {
      vi.mocked(getAllowedDriveIds).mockReturnValue(['drive-other']);

      const response = await POST(createRequest(validBody));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toMatch(/token.*access.*source/i);
    });

    it('allows when MCP token has access to source page drive', async () => {
      vi.mocked(getAllowedDriveIds).mockReturnValue([mockSourceDriveId]);

      const response = await POST(createRequest(validBody));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });

    it('allows when getAllowedDriveIds returns empty (session auth / unscoped)', async () => {
      const response = await POST(createRequest(validBody));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });
  });

  // ── Edit permission checks ──────────────────────────────────────────

  describe('edit permission checks', () => {
    it('returns 403 when user cannot edit a source page', async () => {
      vi.mocked(canUserEditPage).mockResolvedValue(false);

      const response = await POST(createRequest(validBody));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toMatch(/permission.*move.*page/i);
    });

    it('includes page title in permission error', async () => {
      vi.mocked(canUserEditPage).mockResolvedValue(false);
      vi.mocked(db.query.pages.findMany).mockResolvedValue([mockSourcePage({ title: 'Protected Doc' })] as never);

      const response = await POST(createRequest(validBody));
      const body = await response.json();

      expect(body.error).toContain('Protected Doc');
    });
  });

  // ── Circular reference validation ───────────────────────────────────

  describe('circular reference validation', () => {
    it('returns 400 when move would create circular reference', async () => {
      vi.mocked(db.query.pages.findFirst).mockResolvedValue({ id: 'some-parent', position: 3 } as never);
      vi.mocked(validatePageMove).mockResolvedValue({ valid: false, error: 'Cannot move a page into its own descendant' });

      const response = await POST(createRequest({ ...validBody, targetParentId: 'some-parent' }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toMatch(/descendant/i);
    });

    it('skips circular reference check when targetParentId is null', async () => {
      await POST(createRequest({ ...validBody, targetParentId: null }));

      expect(validatePageMove).not.toHaveBeenCalled();
    });

    it('validates each page for circular references', async () => {
      vi.mocked(db.query.pages.findMany).mockResolvedValue([
        mockSourcePage({ id: 'page-1' }),
        mockSourcePage({ id: 'page-2' }),
      ] as never);
      vi.mocked(db.query.pages.findFirst).mockResolvedValue({ id: 'target-parent', position: 3 } as never);

      await POST(createRequest({
        pageIds: ['page-1', 'page-2'],
        targetDriveId: mockTargetDriveId,
        targetParentId: 'target-parent',
      }));

      expect(validatePageMove).toHaveBeenCalledTimes(2);
      expect(validatePageMove).toHaveBeenCalledWith('page-1', 'target-parent');
      expect(validatePageMove).toHaveBeenCalledWith('page-2', 'target-parent');
    });
  });

  // ── Successful move ─────────────────────────────────────────────────

  describe('successful move', () => {
    it('returns success with movedCount', async () => {
      const response = await POST(createRequest(validBody));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.movedCount).toBe(1);
    });

    it('runs move within a transaction', async () => {
      await POST(createRequest(validBody));

      expect(mockTransaction).toHaveBeenCalled();
    });

    it('updates children driveId when moving to a different drive', async () => {
      txQueryPagesFindMany
        .mockResolvedValueOnce([{ id: 'child-1', parentId: 'page-1' }])
        .mockResolvedValue([]);

      await POST(createRequest(validBody));

      // tx.update called for moving parent + updating child driveId
      expect(txUpdate).toHaveBeenCalledTimes(2);
    });

    it('does not update children driveId when staying in same drive', async () => {
      vi.mocked(db.query.pages.findMany).mockResolvedValue([
        mockSourcePage({ driveId: mockTargetDriveId }),
      ] as never);

      await POST(createRequest(validBody));

      // tx.update called only for moving the parent
      expect(txUpdate).toHaveBeenCalledTimes(1);
      expect(txQueryPagesFindMany).not.toHaveBeenCalled();
    });

    it('recursively updates grandchildren driveId for cross-drive moves', async () => {
      txQueryPagesFindMany
        .mockResolvedValueOnce([{ id: 'child-1', parentId: 'page-1' }])
        .mockResolvedValueOnce([{ id: 'grandchild-1', parentId: 'child-1' }])
        .mockResolvedValue([]);

      await POST(createRequest(validBody));

      // tx.update: 1 for parent move + 1 for child driveId + 1 for grandchild driveId
      expect(txUpdate).toHaveBeenCalledTimes(3);
    });

    it('positions moved pages after the last existing page', async () => {
      vi.mocked(db.query.pages.findFirst).mockResolvedValue({ position: 10 } as never);

      await POST(createRequest(validBody));

      const setValues = txUpdateSet.mock.calls[0][0];
      expect(setValues.position).toBe(11);
    });

    it('starts at position 1 when no existing pages', async () => {
      vi.mocked(db.query.pages.findFirst).mockResolvedValue(undefined as never);

      await POST(createRequest(validBody));

      const setValues = txUpdateSet.mock.calls[0][0];
      expect(setValues.position).toBe(1);
    });

    it('handles multiple pages with incrementing positions', async () => {
      vi.mocked(db.query.pages.findMany).mockResolvedValue([
        mockSourcePage({ id: 'page-1', driveId: mockTargetDriveId }),
        mockSourcePage({ id: 'page-2', driveId: mockTargetDriveId }),
      ] as never);
      vi.mocked(db.query.pages.findFirst).mockResolvedValue({ position: 5 } as never);

      await POST(createRequest({
        pageIds: ['page-1', 'page-2'],
        targetDriveId: mockTargetDriveId,
        targetParentId: null,
      }));

      expect(txUpdateSet.mock.calls[0][0].position).toBe(6);
      expect(txUpdateSet.mock.calls[1][0].position).toBe(7);
    });
  });

  // ── Side effects ────────────────────────────────────────────────────

  describe('side effects', () => {
    it('invalidates page tree cache for target drive', async () => {
      vi.mocked(db.query.pages.findMany).mockResolvedValue([
        mockSourcePage({ driveId: mockTargetDriveId }),
      ] as never);

      await POST(createRequest(validBody));

      expect(pageTreeCache.invalidateDriveTree).toHaveBeenCalledWith(mockTargetDriveId);
    });

    it('invalidates page tree cache for source drives too', async () => {
      await POST(createRequest(validBody));

      expect(pageTreeCache.invalidateDriveTree).toHaveBeenCalledWith(mockTargetDriveId);
      expect(pageTreeCache.invalidateDriveTree).toHaveBeenCalledWith(mockSourceDriveId);
    });

    it('broadcasts moved event for each affected drive', async () => {
      vi.mocked(db.query.pages.findMany).mockResolvedValue([
        mockSourcePage({ id: 'page-1', driveId: 'drive-a' }),
        mockSourcePage({ id: 'page-2', driveId: 'drive-b' }),
      ] as never);

      await POST(createRequest({
        pageIds: ['page-1', 'page-2'],
        targetDriveId: mockTargetDriveId,
        targetParentId: null,
      }));

      // target + source-a + source-b = 3 broadcasts
      expect(broadcastPageEvent).toHaveBeenCalledTimes(3);
    });

    it('deduplicates drive IDs for cache/broadcast when source equals target', async () => {
      vi.mocked(db.query.pages.findMany).mockResolvedValue([
        mockSourcePage({ driveId: mockTargetDriveId }),
      ] as never);

      await POST(createRequest(validBody));

      // Only 1 broadcast since source == target
      expect(broadcastPageEvent).toHaveBeenCalledTimes(1);
    });

    it('logs activity for each moved page', async () => {
      vi.mocked(db.query.pages.findMany).mockResolvedValue([
        mockSourcePage({ id: 'page-1', title: 'Page One' }),
        mockSourcePage({ id: 'page-2', title: 'Page Two' }),
      ] as never);

      await POST(createRequest({
        pageIds: ['page-1', 'page-2'],
        targetDriveId: mockTargetDriveId,
        targetParentId: null,
      }));

      expect(logPageActivity).toHaveBeenCalledTimes(2);
    });

    it('includes MCP source in activity metadata when MCP auth', async () => {
      vi.mocked(isMCPAuthResult).mockReturnValue(true);

      await POST(createRequest(validBody));

      expect(logPageActivity).toHaveBeenCalledWith(
        mockUserId,
        'move',
        expect.objectContaining({ id: 'page-1' }),
        expect.objectContaining({
          metadata: expect.objectContaining({ source: 'mcp' }),
        }),
      );
    });

    it('does not include MCP source for session auth', async () => {
      await POST(createRequest(validBody));

      const call = vi.mocked(logPageActivity).mock.calls[0];
      const opts = call[3] as { metadata: Record<string, unknown> };
      expect(opts.metadata.source).toBeUndefined();
    });

    it('logs activity with page title as undefined when title is null', async () => {
      vi.mocked(db.query.pages.findMany).mockResolvedValue([
        mockSourcePage({ title: null }),
      ] as never);

      await POST(createRequest(validBody));

      expect(logPageActivity).toHaveBeenCalledWith(
        mockUserId,
        'move',
        expect.objectContaining({ title: undefined }),
        expect.anything(),
      );
    });

    it('handles cache invalidation failure gracefully', async () => {
      vi.mocked(pageTreeCache.invalidateDriveTree).mockRejectedValue(new Error('Cache error'));

      const response = await POST(createRequest(validBody));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });
  });

  // ── Error handling ──────────────────────────────────────────────────

  describe('error handling', () => {
    it('returns 500 when transaction throws', async () => {
      mockTransaction.mockRejectedValueOnce(new Error('Database error'));

      const response = await POST(createRequest(validBody));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toMatch(/failed.*move/i);
    });
  });
});
