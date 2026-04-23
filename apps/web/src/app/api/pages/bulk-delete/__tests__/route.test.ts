/**
 * Contract tests for DELETE /api/pages/bulk-delete
 *
 * These tests verify the route handler's contract:
 * - Authentication checks
 * - Request validation via Zod schema
 * - MCP token scope checks
 * - Page existence and permission checks
 * - Trash with/without children
 * - Recursive child trashing
 * - Side effects: broadcast, activity logging
 * - Error handling
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ── Mocks (before imports) ──────────────────────────────────────────────

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result: unknown) => result !== null && typeof result === 'object' && 'error' in (result as Record<string, unknown>)),
  getAllowedDriveIds: vi.fn(() => []),
  isMCPAuthResult: vi.fn(() => false),
}));

vi.mock('@/lib/websocket', () => ({
  broadcastPageEvent: vi.fn().mockResolvedValue(undefined),
  createPageEventPayload: vi.fn((driveId: string, pageId: string, type: string) => ({
    driveId, pageId, type,
  })),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
    loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },

  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
    auditRequest: vi.fn(),
}));
vi.mock('@pagespace/lib/permissions/permissions', () => ({
    canUserDeletePage: vi.fn().mockResolvedValue(true),
}));

vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  getActorInfo: vi.fn().mockResolvedValue({ actorEmail: 'test@example.com', actorDisplayName: 'Test User' }),
  logPageActivity: vi.fn(),
}));

vi.mock('@pagespace/lib/monitoring/change-group', () => ({
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
        pages: { findMany: vi.fn() },
      },
      transaction,
    },
    __test__: { txUpdate, txUpdateSet, txUpdateWhere, txQueryPagesFindMany, transaction },
    pages: { id: 'id', parentId: 'parentId' },
    eq: vi.fn((a: unknown, b: unknown) => [a, b]),
    inArray: vi.fn((a: unknown, b: unknown) => [a, b]),
  };
});

// ── Imports (after mocks) ───────────────────────────────────────────────

import { DELETE } from '../route';
import { authenticateRequestWithOptions, getAllowedDriveIds, isMCPAuthResult } from '@/lib/auth';
import { broadcastPageEvent } from '@/lib/websocket';
import { canUserDeletePage } from '@pagespace/lib/permissions/permissions'
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { logPageActivity } from '@pagespace/lib/monitoring/activity-logger';
// @ts-expect-error - accessing test-only export
import { db, __test__ as dbTest } from '@pagespace/db';

const { txUpdate, txUpdateSet, txUpdateWhere, txQueryPagesFindMany, transaction: mockTransaction } = dbTest as {
  txUpdate: ReturnType<typeof vi.fn>;
  txUpdateSet: ReturnType<typeof vi.fn>;
  txUpdateWhere: ReturnType<typeof vi.fn>;
  txQueryPagesFindMany: ReturnType<typeof vi.fn>;
  transaction: ReturnType<typeof vi.fn>;
};

// ── Helpers ─────────────────────────────────────────────────────────────

const mockUserId = 'user_123';
const mockDriveId = 'drive_123';

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
  new Request('https://example.com/api/pages/bulk-delete', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const mockPage = (overrides = {}) => ({
  id: 'page-1',
  title: 'Test Page',
  type: 'DOCUMENT',
  driveId: mockDriveId,
  parentId: null,
  isTrashed: false,
  ...overrides,
});

const validBody = {
  pageIds: ['page-1'],
  trashChildren: true,
};

function setupSuccessScenario() {
  // Auth
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
  vi.mocked(getAllowedDriveIds).mockReturnValue([]);
  vi.mocked(isMCPAuthResult).mockReturnValue(false);

  // DB queries
  vi.mocked(db.query.pages.findMany).mockResolvedValue([mockPage()] as never);

  // Permissions
  vi.mocked(canUserDeletePage).mockResolvedValue(true);

  // Transaction mocks
  txUpdateWhere.mockResolvedValue(undefined);
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

describe('DELETE /api/pages/bulk-delete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupSuccessScenario();
  });

  // ── Authentication ──────────────────────────────────────────────────

  describe('authentication', () => {
    it('returns auth error when user is not authenticated', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const response = await DELETE(createRequest(validBody));

      expect(response.status).toBe(401);
    });
  });

  // ── Validation ──────────────────────────────────────────────────────

  describe('validation', () => {
    it('returns 400 when pageIds is empty', async () => {
      const response = await DELETE(createRequest({ pageIds: [], trashChildren: true }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('At least one page ID is required');
    });

    it('returns 400 when pageIds is missing', async () => {
      const response = await DELETE(createRequest({ trashChildren: true }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid input: expected array, received undefined');
    });

    it('defaults trashChildren to true when not provided', async () => {
      const response = await DELETE(createRequest({ pageIds: ['page-1'] }));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });
  });

  // ── Source pages validation ─────────────────────────────────────────

  describe('source pages validation', () => {
    it('returns 404 when some pages not found', async () => {
      vi.mocked(db.query.pages.findMany).mockResolvedValue([] as never);

      const response = await DELETE(createRequest(validBody));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toMatch(/some pages not found/i);
    });

    it('returns 404 when count mismatch between found and requested', async () => {
      const response = await DELETE(createRequest({ pageIds: ['page-1', 'page-2'], trashChildren: true }));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toMatch(/some pages not found/i);
    });
  });

  // ── MCP scope checks ───────────────────────────────────────────────

  describe('MCP scope checks', () => {
    it('returns 403 when MCP token does not have access to page drive', async () => {
      vi.mocked(getAllowedDriveIds).mockReturnValue(['other-drive']);

      const response = await DELETE(createRequest(validBody));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toMatch(/token.*access/i);
    });

    it('allows when MCP token has access to page drive', async () => {
      vi.mocked(getAllowedDriveIds).mockReturnValue([mockDriveId]);

      const response = await DELETE(createRequest(validBody));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });

    it('allows when getAllowedDriveIds returns empty (session auth)', async () => {
      const response = await DELETE(createRequest(validBody));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });
  });

  // ── Delete permission checks ────────────────────────────────────────

  describe('delete permission checks', () => {
    it('returns 403 when user cannot delete a page', async () => {
      vi.mocked(canUserDeletePage).mockResolvedValue(false);

      const response = await DELETE(createRequest(validBody));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toMatch(/permission.*delete.*page/i);
    });

    it('includes page title in permission error', async () => {
      vi.mocked(canUserDeletePage).mockResolvedValue(false);
      vi.mocked(db.query.pages.findMany).mockResolvedValue([mockPage({ title: 'Private Doc' })] as never);

      const response = await DELETE(createRequest(validBody));
      const body = await response.json();

      expect(body.error).toContain('Private Doc');
    });
  });

  // ── Successful trash ────────────────────────────────────────────────

  describe('successful trash', () => {
    it('returns success with trashedCount', async () => {
      const response = await DELETE(createRequest(validBody));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.trashedCount).toBe(1);
    });

    it('runs trash within a transaction', async () => {
      await DELETE(createRequest(validBody));

      expect(mockTransaction).toHaveBeenCalledTimes(1);
      expect(typeof mockTransaction.mock.calls[0][0]).toBe('function');
    });

    it('trashes children recursively when trashChildren is true', async () => {
      txQueryPagesFindMany
        .mockResolvedValueOnce([
          { id: 'child-1', type: 'DOCUMENT', parentId: 'page-1' },
        ])
        .mockResolvedValue([]);

      await DELETE(createRequest(validBody));

      // tx.update called for parent + child
      expect(txUpdate).toHaveBeenCalledTimes(2);
    });

    it('moves children to grandparent when trashChildren is false', async () => {
      vi.mocked(db.query.pages.findMany).mockResolvedValue([
        mockPage({ parentId: 'grandparent-id' }),
      ] as never);

      await DELETE(createRequest({ pageIds: ['page-1'], trashChildren: false }));

      // tx.update called for trashing parent + reparenting children
      expect(txUpdate).toHaveBeenCalledTimes(2);
    });

    it('handles multiple pages from different drives', async () => {
      vi.mocked(db.query.pages.findMany).mockResolvedValue([
        mockPage({ id: 'page-1', driveId: 'drive-a' }),
        mockPage({ id: 'page-2', driveId: 'drive-b' }),
      ] as never);

      const response = await DELETE(createRequest({
        pageIds: ['page-1', 'page-2'],
        trashChildren: false,
      }));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.trashedCount).toBe(2);
    });

  });

  // ── Side effects ────────────────────────────────────────────────────

  describe('side effects', () => {
    it('broadcasts trashed event for each affected drive', async () => {
      vi.mocked(db.query.pages.findMany).mockResolvedValue([
        mockPage({ id: 'page-1', driveId: 'drive-a' }),
        mockPage({ id: 'page-2', driveId: 'drive-b' }),
      ] as never);

      await DELETE(createRequest({
        pageIds: ['page-1', 'page-2'],
        trashChildren: false,
      }));

      expect(broadcastPageEvent).toHaveBeenCalledTimes(2);
    });

    it('logs activity for each trashed page', async () => {
      vi.mocked(db.query.pages.findMany).mockResolvedValue([
        mockPage({ id: 'page-1', title: 'Page One' }),
        mockPage({ id: 'page-2', title: 'Page Two' }),
      ] as never);

      await DELETE(createRequest({
        pageIds: ['page-1', 'page-2'],
        trashChildren: true,
      }));

      expect(logPageActivity).toHaveBeenCalledTimes(2);
    });

    it('includes MCP source in activity metadata when MCP auth', async () => {
      vi.mocked(isMCPAuthResult).mockReturnValue(true);

      await DELETE(createRequest(validBody));

      expect(logPageActivity).toHaveBeenCalledWith(
        mockUserId,
        'trash',
        expect.objectContaining({ id: 'page-1' }),
        expect.objectContaining({
          metadata: expect.objectContaining({ source: 'mcp' }),
        }),
      );
    });

    it('does not include MCP source for session auth', async () => {
      await DELETE(createRequest(validBody));

      const call = vi.mocked(logPageActivity).mock.calls[0];
      const opts = call[3] as { metadata: Record<string, unknown> };
      expect(opts.metadata.source).toBeUndefined();
    });

    it('logs delete audit event with count only (no pageIds array)', async () => {
      await DELETE(createRequest(validBody));

      expect(auditRequest).toHaveBeenCalledWith(
        expect.any(Request),
        expect.objectContaining({ eventType: 'data.delete', userId: mockUserId, resourceType: 'page', resourceId: 'bulk' })
      );
    });

    it('logs activity with page title as undefined when title is null', async () => {
      vi.mocked(db.query.pages.findMany).mockResolvedValue([
        mockPage({ title: null }),
      ] as never);

      await DELETE(createRequest(validBody));

      expect(logPageActivity).toHaveBeenCalledWith(
        mockUserId,
        'trash',
        expect.objectContaining({ title: undefined }),
        expect.objectContaining({
          actorEmail: 'test@example.com',
          actorDisplayName: 'Test User',
          changeGroupId: 'change-group-123',
          changeGroupType: 'user',
        }),
      );
    });
  });

  // ── Error handling ──────────────────────────────────────────────────

  describe('error handling', () => {
    it('returns 500 when transaction throws', async () => {
      mockTransaction.mockRejectedValueOnce(new Error('Database error'));

      const response = await DELETE(createRequest(validBody));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toMatch(/failed.*delete/i);
    });
  });
});
