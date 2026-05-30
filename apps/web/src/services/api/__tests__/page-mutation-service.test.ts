/**
 * Unit tests for applyPageMutation's no-op guard.
 *
 * Regression coverage for "Activity/Pulse think I edited a page just by
 * visiting it": when a page is opened, an editor may re-emit its loaded
 * content, producing a PATCH whose resulting page state is identical to the
 * stored state. applyPageMutation must treat that as a no-op — no revision
 * bump, no page version, and no 'update' activity log — so it is never
 * recorded as an edit. Updates that touch fields outside the state hash (e.g.
 * isPrivate) must always be recorded.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const {
  currentPageHolder,
  mockSelectLimit,
  mockTransaction,
  mockUpdateReturning,
  mockLogActivityWithTx,
  mockCreatePageVersion,
  mockWritePageContent,
  mockSyncMentions,
  mockComputePageStateHash,
  mockHashWithPrefix,
} = vi.hoisted(() => ({
  currentPageHolder: { row: null as Record<string, unknown> | null },
  mockSelectLimit: vi.fn(),
  mockTransaction: vi.fn(),
  mockUpdateReturning: vi.fn().mockResolvedValue([{ id: 'page-1' }]),
  mockLogActivityWithTx: vi.fn().mockResolvedValue(() => {}),
  mockCreatePageVersion: vi.fn().mockResolvedValue(undefined),
  mockWritePageContent: vi.fn().mockResolvedValue({ ref: 'snap-ref', size: 0 }),
  mockSyncMentions: vi.fn().mockResolvedValue(null),
  // Deterministic, faithful hash: equal inputs => equal hash.
  mockComputePageStateHash: vi.fn((input: unknown) => JSON.stringify(input)),
  mockHashWithPrefix: vi.fn((_format: string, content: string) => `h:${content}`),
}));

// ── vi.mock declarations ───────────────────────────────────────────────────

const txMock = {
  update: vi.fn(() => ({
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    returning: (...args: unknown[]) => mockUpdateReturning(...args),
  })),
};

const selectChain = {
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  limit: (...args: unknown[]) => mockSelectLimit(...args),
};

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: vi.fn(() => selectChain),
    transaction: (...args: unknown[]) => mockTransaction(...args),
  },
}));

vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
  and: vi.fn(),
}));

vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'id', revision: 'revision' },
}));

vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  logActivityWithTx: (...args: unknown[]) => mockLogActivityWithTx(...args),
}));

vi.mock('@pagespace/lib/monitoring/change-group', () => ({
  inferChangeGroupType: vi.fn(() => 'user'),
  createChangeGroupId: vi.fn(() => 'cg-1'),
}));

vi.mock('@pagespace/lib/services/page-version-service', () => ({
  computePageStateHash: (...args: unknown[]) => mockComputePageStateHash(...args),
  createPageVersion: (...args: unknown[]) => mockCreatePageVersion(...args),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } },
}));

vi.mock('@pagespace/lib/services/page-content-store', () => ({
  writePageContent: (...args: unknown[]) => mockWritePageContent(...args),
}));

vi.mock('@pagespace/lib/content/page-content-format', () => ({
  detectPageContentFormat: vi.fn(() => 'html'),
}));

vi.mock('@pagespace/lib/utils/hash-utils', () => ({
  hashWithPrefix: (...args: unknown[]) => mockHashWithPrefix(...(args as [string, string])),
}));

vi.mock('@/services/api/page-mention-service', () => ({
  syncMentions: (...args: unknown[]) => mockSyncMentions(...args),
}));

vi.mock('@pagespace/lib/notifications/notifications', () => ({
  createMentionNotification: vi.fn().mockResolvedValue(undefined),
}));

import { applyPageMutation } from '@/services/api/page-mutation-service';

// ── Fixtures ────────────────────────────────────────────────────────────────

const buildPage = (overrides: Record<string, unknown> = {}) => ({
  id: 'page-1',
  title: 'Doc',
  content: '<p>hello</p>',
  type: 'DOCUMENT',
  driveId: 'drive-1',
  parentId: null,
  position: 1,
  isTrashed: false,
  revision: 5,
  aiProvider: null,
  aiModel: null,
  systemPrompt: null,
  enabledTools: null,
  isPaginated: false,
  includeDrivePrompt: false,
  agentDefinition: null,
  visibleToGlobalAssistant: true,
  includePageTree: false,
  pageTreeScope: 'children',
  isPrivate: false,
  ...overrides,
});

const context = { userId: 'user-1', actorEmail: 'user@example.com' };

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdateReturning.mockResolvedValue([{ id: 'page-1' }]);
  mockLogActivityWithTx.mockResolvedValue(() => {});
  mockTransaction.mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
    await cb(txMock);
  });
  const row = buildPage();
  currentPageHolder.row = row;
  mockSelectLimit.mockResolvedValue([row]);
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe('applyPageMutation no-op guard', () => {
  it('skips revision bump, version, and activity log when content is unchanged', async () => {
    const result = await applyPageMutation({
      pageId: 'page-1',
      operation: 'update',
      updates: { content: '<p>hello</p>' }, // identical to stored content
      updatedFields: ['content'],
      context,
    });

    // No write side effects whatsoever.
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockCreatePageVersion).not.toHaveBeenCalled();
    expect(mockLogActivityWithTx).not.toHaveBeenCalled();
    expect(mockWritePageContent).not.toHaveBeenCalled();

    // Revision is unchanged and no deferred workflow trigger is returned.
    expect(result.nextRevision).toBe(5);
    expect(result.stateHashBefore).toBe(result.stateHashAfter);
    expect(result.deferredTrigger).toBeUndefined();
  });

  it('records an edit when content actually changes', async () => {
    const result = await applyPageMutation({
      pageId: 'page-1',
      operation: 'update',
      updates: { content: '<p>goodbye</p>' },
      updatedFields: ['content'],
      context,
    });

    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockCreatePageVersion).toHaveBeenCalledTimes(1);
    expect(mockLogActivityWithTx).toHaveBeenCalledTimes(1);
    expect(result.nextRevision).toBe(6);
    expect(result.stateHashBefore).not.toBe(result.stateHashAfter);
  });

  it('records an edit when only a non-hashed field (isPrivate) changes', async () => {
    // isPrivate is not part of the page state hash, so the hash is unchanged,
    // but the update must still be recorded — the guard must not swallow it.
    const result = await applyPageMutation({
      pageId: 'page-1',
      operation: 'update',
      updates: { isPrivate: true },
      updatedFields: ['isPrivate'],
      context,
    });

    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockLogActivityWithTx).toHaveBeenCalledTimes(1);
    expect(result.nextRevision).toBe(6);
  });

  it('skips when a no-op update lists only hashed fields with unchanged values', async () => {
    const result = await applyPageMutation({
      pageId: 'page-1',
      operation: 'update',
      updates: { title: 'Doc', content: '<p>hello</p>' }, // same as stored
      updatedFields: ['title', 'content'],
      context,
    });

    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockLogActivityWithTx).not.toHaveBeenCalled();
    expect(result.nextRevision).toBe(5);
  });
});
