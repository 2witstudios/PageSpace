/**
 * Contract tests for POST /api/pages/bulk-copy
 *
 * These tests verify the route handler's contract:
 * - Authentication and authorization checks
 * - Request validation via Zod schema
 * - MCP token scope checks for source and target drives
 * - Drive/page existence validation
 * - Permission checks (view source, edit target)
 * - Recursive child copying
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
  canUserViewPage: vi.fn().mockResolvedValue(true),
}));

vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  getActorInfo: vi.fn().mockResolvedValue({ actorEmail: 'test@example.com', actorDisplayName: 'Test User' }),
  logPageActivity: vi.fn(),
}));

vi.mock('@pagespace/lib/monitoring', () => ({
  createChangeGroupId: vi.fn(() => 'change-group-123'),
}));

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => 'new-page-id'),
  isCuid: vi.fn(() => true),
}));

vi.mock('@pagespace/db', () => {
  const txInsertValues = vi.fn().mockResolvedValue(undefined);
  const txInsert = vi.fn().mockReturnValue({ values: txInsertValues });
  const txQueryPagesFindMany = vi.fn().mockResolvedValue([]);
  const tx = {
    insert: txInsert,
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
    __test__: { txInsert, txInsertValues, txQueryPagesFindMany, transaction },
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
import { pageTreeCache, canUserViewPage } from '@pagespace/lib/server';
import { logPageActivity } from '@pagespace/lib/monitoring/activity-logger';
import { db, __test__ as dbTest } from '@pagespace/db';
import { createId } from '@paralleldrive/cuid2';

const { txInsert, txInsertValues, txQueryPagesFindMany, transaction: mockTransaction } = dbTest as {
  txInsert: ReturnType<typeof vi.fn>;
  txInsertValues: ReturnType<typeof vi.fn>;
  txQueryPagesFindMany: ReturnType<typeof vi.fn>;
  transaction: ReturnType<typeof vi.fn>;
};

// ── Helpers ─────────────────────────────────────────────────────────────

const mockUserId = 'user_123';
const mockDriveId = 'drive_target';
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
  new Request('https://example.com/api/pages/bulk-copy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const mockSourcePage = (overrides = {}) => ({
  id: 'page-1',
  title: 'Source Page',
  type: 'DOCUMENT',
  content: '<p>Hello</p>',
  driveId: mockSourceDriveId,
  parentId: null,
  position: 1,
  revision: 5,
  stateHash: 'hash',
  isTrashed: false,
  aiProvider: null,
  aiModel: null,
  systemPrompt: null,
  enabledTools: null,
  isPaginated: null,
  includeDrivePrompt: null,
  agentDefinition: null,
  visibleToGlobalAssistant: null,
  includePageTree: null,
  pageTreeScope: null,
  fileSize: null,
  mimeType: null,
  originalFileName: null,
  filePath: null,
  fileMetadata: null,
  processingStatus: null,
  processingError: null,
  processedAt: null,
  extractionMethod: null,
  extractionMetadata: null,
  contentHash: null,
  ...overrides,
});

const validBody = {
  pageIds: ['page-1'],
  targetDriveId: mockDriveId,
  targetParentId: null,
  includeChildren: true,
};

function setupSuccessScenario() {
  // Auth
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
  vi.mocked(checkMCPDriveScope).mockReturnValue(null);
  vi.mocked(getAllowedDriveIds).mockReturnValue([]);
  vi.mocked(isMCPAuthResult).mockReturnValue(false);

  // DB queries
  vi.mocked(db.query.drives.findFirst).mockResolvedValue({ id: mockDriveId, ownerId: mockUserId } as never);
  vi.mocked(db.query.driveMembers.findFirst).mockResolvedValue(undefined as never);
  vi.mocked(db.query.pages.findMany).mockResolvedValue([mockSourcePage()] as never);
  vi.mocked(db.query.pages.findFirst).mockResolvedValue({ position: 5 } as never);

  // Permissions
  vi.mocked(canUserViewPage).mockResolvedValue(true);

  // Page tree cache
  vi.mocked(pageTreeCache.invalidateDriveTree).mockResolvedValue(undefined);

  // Transaction mocks
  txInsertValues.mockResolvedValue(undefined);
  txInsert.mockReturnValue({ values: txInsertValues });
  txQueryPagesFindMany.mockResolvedValue([]);
  mockTransaction.mockImplementation(async (fn: (t: unknown) => Promise<void>) => {
    await fn({
      insert: txInsert,
      query: { pages: { findMany: txQueryPagesFindMany } },
    });
  });
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('POST /api/pages/bulk-copy', () => {
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
      const response = await POST(createRequest({ targetDriveId: mockDriveId, targetParentId: null }));
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

    it('defaults includeChildren to true when not provided', async () => {
      const response = await POST(createRequest({
        pageIds: ['page-1'],
        targetDriveId: mockDriveId,
        targetParentId: null,
      }));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
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
      vi.mocked(db.query.drives.findFirst).mockResolvedValue({ id: mockDriveId, ownerId: 'other-user' } as never);
      vi.mocked(db.query.driveMembers.findFirst).mockResolvedValue({ role: 'ADMIN' } as never);

      const response = await POST(createRequest(validBody));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });

    it('allows when user is drive OWNER member', async () => {
      vi.mocked(db.query.drives.findFirst).mockResolvedValue({ id: mockDriveId, ownerId: 'other-user' } as never);
      vi.mocked(db.query.driveMembers.findFirst).mockResolvedValue({ role: 'OWNER' } as never);

      const response = await POST(createRequest(validBody));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });

    it('returns 403 when user is only a VIEWER member', async () => {
      vi.mocked(db.query.drives.findFirst).mockResolvedValue({ id: mockDriveId, ownerId: 'other-user' } as never);
      vi.mocked(db.query.driveMembers.findFirst).mockResolvedValue({ role: 'VIEWER' } as never);

      const response = await POST(createRequest(validBody));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toMatch(/permission.*copy/i);
    });

    it('returns 403 when user has no membership', async () => {
      vi.mocked(db.query.drives.findFirst).mockResolvedValue({ id: mockDriveId, ownerId: 'other-user' } as never);
      vi.mocked(db.query.driveMembers.findFirst).mockResolvedValue(undefined as never);

      const response = await POST(createRequest(validBody));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toMatch(/permission.*copy/i);
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

  // ── View permission checks ──────────────────────────────────────────

  describe('view permission checks', () => {
    it('returns 403 when user cannot view a source page', async () => {
      vi.mocked(canUserViewPage).mockResolvedValue(false);

      const response = await POST(createRequest(validBody));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toMatch(/permission.*copy.*page/i);
    });

    it('includes page title in permission error', async () => {
      vi.mocked(canUserViewPage).mockResolvedValue(false);
      vi.mocked(db.query.pages.findMany).mockResolvedValue([mockSourcePage({ title: 'Secret Doc' })] as never);

      const response = await POST(createRequest(validBody));
      const body = await response.json();

      expect(body.error).toContain('Secret Doc');
    });
  });

  // ── Successful copy ─────────────────────────────────────────────────

  describe('successful copy', () => {
    it('returns success with copiedCount', async () => {
      const response = await POST(createRequest(validBody));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.copiedCount).toBe(1);
    });

    it('runs copy within a transaction', async () => {
      await POST(createRequest(validBody));

      expect(mockTransaction).toHaveBeenCalled();
    });

    it('creates page with (Copy) suffix in title', async () => {
      await POST(createRequest(validBody));

      expect(txInsert).toHaveBeenCalled();
      const insertedValues = txInsertValues.mock.calls[0][0];
      expect(insertedValues.title).toBe('Source Page (Copy)');
    });

    it('creates page with Untitled (Copy) when title is null', async () => {
      vi.mocked(db.query.pages.findMany).mockResolvedValue([mockSourcePage({ title: null })] as never);

      await POST(createRequest(validBody));

      const insertedValues = txInsertValues.mock.calls[0][0];
      expect(insertedValues.title).toBe('Untitled (Copy)');
    });

    it('sets processingStatus to pending for FILE type pages', async () => {
      vi.mocked(db.query.pages.findMany).mockResolvedValue([mockSourcePage({ type: 'FILE' })] as never);

      await POST(createRequest(validBody));

      const insertedValues = txInsertValues.mock.calls[0][0];
      expect(insertedValues.processingStatus).toBe('pending');
    });

    it('sets processingStatus to null for non-FILE type pages', async () => {
      await POST(createRequest(validBody));

      const insertedValues = txInsertValues.mock.calls[0][0];
      expect(insertedValues.processingStatus).toBeNull();
    });

    it('copies children recursively when includeChildren is true', async () => {
      txQueryPagesFindMany
        .mockResolvedValueOnce([
          {
            id: 'child-1', title: 'Child', type: 'DOCUMENT', content: '', position: 1,
            isTrashed: false, aiProvider: null, aiModel: null, systemPrompt: null,
            enabledTools: null, isPaginated: null, includeDrivePrompt: null,
            agentDefinition: null, visibleToGlobalAssistant: null, includePageTree: null,
            pageTreeScope: null, fileSize: null, mimeType: null, originalFileName: null,
            filePath: null, fileMetadata: null, extractionMethod: null,
            extractionMetadata: null, contentHash: null,
          },
        ])
        .mockResolvedValue([]);

      const response = await POST(createRequest(validBody));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.copiedCount).toBe(2);
    });

    it('does not copy children when includeChildren is false', async () => {
      const response = await POST(createRequest({ ...validBody, includeChildren: false }));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.copiedCount).toBe(1);
      expect(txQueryPagesFindMany).not.toHaveBeenCalled();
    });

    it('handles multiple source pages', async () => {
      vi.mocked(db.query.pages.findMany).mockResolvedValue([
        mockSourcePage({ id: 'page-1' }),
        mockSourcePage({ id: 'page-2', title: 'Page Two' }),
      ] as never);
      vi.mocked(createId).mockReturnValueOnce('new-1').mockReturnValueOnce('new-2');

      const response = await POST(createRequest({
        ...validBody,
        pageIds: ['page-1', 'page-2'],
        includeChildren: false,
      }));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.copiedCount).toBe(2);
    });

    it('positions copied pages after the last existing page', async () => {
      vi.mocked(db.query.pages.findFirst).mockResolvedValue({ position: 10 } as never);

      await POST(createRequest({ ...validBody, includeChildren: false }));

      const insertedValues = txInsertValues.mock.calls[0][0];
      expect(insertedValues.position).toBe(11);
    });

    it('starts at position 1 when no existing pages', async () => {
      // findFirst for lastPage returns undefined (no pages exist)
      // But findFirst is also used for targetParent (not called since targetParentId is null)
      vi.mocked(db.query.pages.findFirst).mockResolvedValue(undefined as never);

      await POST(createRequest({ ...validBody, includeChildren: false }));

      const insertedValues = txInsertValues.mock.calls[0][0];
      expect(insertedValues.position).toBe(1);
    });
  });

  // ── Side effects ────────────────────────────────────────────────────

  describe('side effects', () => {
    it('invalidates page tree cache for target drive', async () => {
      await POST(createRequest(validBody));

      expect(pageTreeCache.invalidateDriveTree).toHaveBeenCalledWith(mockDriveId);
    });

    it('broadcasts page created event', async () => {
      await POST(createRequest(validBody));

      expect(broadcastPageEvent).toHaveBeenCalled();
    });

    it('logs activity for each copied page', async () => {
      vi.mocked(db.query.pages.findMany).mockResolvedValue([
        mockSourcePage({ id: 'page-1', title: 'Page One' }),
        mockSourcePage({ id: 'page-2', title: 'Page Two' }),
      ] as never);
      vi.mocked(createId).mockReturnValueOnce('new-1').mockReturnValueOnce('new-2');

      await POST(createRequest({
        ...validBody,
        pageIds: ['page-1', 'page-2'],
        includeChildren: false,
      }));

      expect(logPageActivity).toHaveBeenCalledTimes(2);
    });

    it('includes MCP source in activity metadata when MCP auth', async () => {
      vi.mocked(isMCPAuthResult).mockReturnValue(true);

      await POST(createRequest({ ...validBody, includeChildren: false }));

      expect(logPageActivity).toHaveBeenCalledWith(
        mockUserId,
        'create',
        expect.objectContaining({ driveId: mockDriveId }),
        expect.objectContaining({
          metadata: expect.objectContaining({ source: 'mcp' }),
        }),
      );
    });

    it('does not include MCP source for session auth', async () => {
      await POST(createRequest({ ...validBody, includeChildren: false }));

      const call = vi.mocked(logPageActivity).mock.calls[0];
      const opts = call[3] as { metadata: Record<string, unknown> };
      expect(opts.metadata.source).toBeUndefined();
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
      expect(body.error).toMatch(/failed.*copy/i);
    });
  });
});
