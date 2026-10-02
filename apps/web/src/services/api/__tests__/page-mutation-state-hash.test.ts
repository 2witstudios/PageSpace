/**
 * Agent-config fields are part of a page's version state: a change to one must
 * change the state hash `applyPageMutation` records. toolApprovalMode sits
 * alongside toolExposureMode and the other agent settings.
 *
 * Harness mirrors page-mutation-reanchor.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';

const mockReanchor = vi.fn(async () => ({ ok: true as const, data: { considered: 0, updated: 0, orphaned: 0, newlyOrphaned: 0, repairedStaleHash: 0, repairedFormatFlip: 0 } }));
const mockSyncMentions = vi.fn(async () => undefined);
const mockLogError = vi.fn();
const mockLogWarn = vi.fn();
const mockComputePageStateHash = vi.fn((_state: Record<string, unknown>) => 'hash');

/**
 * The row `applyPageMutation` reads before it writes.
 *
 * HTML on purpose. The conversion case below converts to markdown, so the old
 * and new modes DIFFER — without that the two are identical and swapping one
 * for the other is invisible, which is exactly how the first version of this
 * test passed while the mutation that swaps them survived.
 */
const currentPage = {
  id: 'page-1',
  driveId: 'drive-1',
  revision: 1,
  type: 'AI_CHAT',
  content: '',
  contentMode: 'html',
  title: 'Agent',
  toolExposureMode: 'upfront',
  toolApprovalMode: 'ask',
};

function queryBuilder(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const method of ['select', 'from', 'where', 'limit', 'update', 'set', 'returning', 'insert', 'values']) {
    chain[method] = vi.fn(() => chain);
  }
  chain.limit = vi.fn(async () => rows);
  chain.returning = vi.fn(async () => rows);
  return chain;
}

/** The nested executor the sweep receives — a SAVEPOINT, not the outer tx. */
const savepoint = { __savepoint: true } as unknown as Record<string, unknown>;

/**
 * The transaction handed to the mutation body.
 *
 * A full query builder, because the mutation writes through it — but ONE stable
 * object, so the assertion that the sweep received this exact executor is an
 * identity check rather than a shape check. A shape check would pass for the db
 * singleton too, which is the bug being guarded against.
 */
const transaction = queryBuilder([currentPage]) as Record<string, unknown> & {
  transaction: ReturnType<typeof vi.fn>;
};
/** Records whether the savepoint body threw, i.e. whether it would have rolled back. */
const savepointRolledBack = { value: false };
transaction.transaction = vi.fn(async (fn: (sp: unknown) => Promise<unknown>) => {
  savepointRolledBack.value = false;
  try {
    return await fn(savepoint);
  } catch (error) {
    // A real SAVEPOINT unwinds here, clearing the aborted transaction state.
    savepointRolledBack.value = true;
    throw error;
  }
});

vi.mock('@pagespace/db/db', () => ({
  db: {
    ...queryBuilder([currentPage]),
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(transaction)),
  },
}));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn(), and: vi.fn() }));
vi.mock('@pagespace/db/schema/core', () => ({ pages: { id: 'id', revision: 'revision' } }));
vi.mock('@pagespace/lib/tags/tag-service', () => ({ reanchorPageTags: (...a: unknown[]) => mockReanchor(...(a as [])) }));
vi.mock('@/services/api/page-mention-service', () => ({ syncMentions: (...a: unknown[]) => mockSyncMentions(...(a as [])) }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({ loggers: { api: { error: (...a: unknown[]) => mockLogError(...(a as [])), warn: (...a: unknown[]) => mockLogWarn(...(a as [])), info: vi.fn() } } }));
vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({ logActivityWithTx: vi.fn(async () => undefined) }));
vi.mock('@pagespace/lib/monitoring/change-group', () => ({ inferChangeGroupType: vi.fn(() => 'edit'), createChangeGroupId: vi.fn(() => 'cg-1') }));
vi.mock('@pagespace/lib/services/page-version-service', () => ({ computePageStateHash: (state: Record<string, unknown>) => mockComputePageStateHash(state), createPageVersion: vi.fn(async () => undefined) }));
vi.mock('@pagespace/lib/services/page-content-store', () => ({ writePageContent: vi.fn(async () => ({ ref: 'stored-ref' })) }));
vi.mock('@pagespace/lib/content/page-content-format', () => ({ detectPageContentFormat: vi.fn(() => 'markdown') }));
vi.mock('@pagespace/lib/utils/hash-utils', () => ({ hashWithPrefix: vi.fn(() => 'ref') }));
vi.mock('@pagespace/lib/sheets/sheet', () => ({ isSheetType: vi.fn(() => false) }));
vi.mock('@pagespace/lib/sheets/store', () => ({ replaceFromDocument: vi.fn(), readSheetDocument: vi.fn(async () => null) }));
vi.mock('@pagespace/lib/utils/enums', () => ({ PageType: { DOCUMENT: 'DOCUMENT' } }));
vi.mock('@pagespace/lib/notifications/notifications', () => ({ createMentionNotification: vi.fn(async () => undefined) }));

const { applyPageMutation } = await import('../page-mutation-service');

describe('applyPageMutation state hash', () => {
  it('captures toolApprovalMode before and after, so the change is versioned', async () => {
    mockComputePageStateHash.mockClear();
    await applyPageMutation({
      pageId: 'page-1',
      operation: 'update',
      updates: { toolApprovalMode: 'auto' },
      updatedFields: ['toolApprovalMode'],
      expectedRevision: 1,
      context: { userId: 'user-1' },
      source: 'user',
    } as never);

    const [before, after] = mockComputePageStateHash.mock.calls.map(([state]) => state);
    expect(before).toMatchObject({ toolApprovalMode: 'ask' });
    expect(after).toMatchObject({ toolApprovalMode: 'auto' });
  });
});
