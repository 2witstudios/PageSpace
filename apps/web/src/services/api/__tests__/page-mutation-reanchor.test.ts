/**
 * The content-tag re-anchoring hook inside `applyPageMutation`.
 *
 * WHY THIS TEST EXISTS. Forward-porting is the PRIMARY anchoring mechanism, and
 * `applyPageMutation` is its only possible call site: `previousContent` and
 * `nextContent` exist together in exactly one transaction in the codebase. Every
 * way this wiring can break is silent —
 *
 *   - the call removed        -> every edit degrades to quote repair, the
 *                                accuracy floor, and nothing fails
 *   - the wrong executor      -> anchors commit independently of the content
 *                                they describe (both reviewers of #2494 raised
 *                                this one)
 *   - the wrong content modes -> convert-content-mode projects the old revision
 *                                with the new mode and orphans every anchor
 *
 * None of those makes a test go red on their own, so they are asserted here
 * directly. The porting BEHAVIOUR is covered against real Postgres by
 * packages/lib/src/tags/__tests__/tag-service.integration.test.ts; this file
 * only pins the seam.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockReanchor = vi.fn(async () => ({ ok: true as const, data: { considered: 0, updated: 0, orphaned: 0, skippedStaleHash: 0, skippedFormatFlip: 0 } }));
const mockSyncMentions = vi.fn(async () => undefined);
const mockLogError = vi.fn();

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
  type: 'DOCUMENT',
  content: 'the original content',
  contentMode: 'html',
  title: 'Doc',
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

/**
 * The transaction handed to the mutation body.
 *
 * A full query builder, because the mutation writes through it — but ONE stable
 * object, so the assertion that the sweep received this exact executor is an
 * identity check rather than a shape check. A shape check would pass for the db
 * singleton too, which is the bug being guarded against.
 */
const transaction = queryBuilder([currentPage]);

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
vi.mock('@pagespace/lib/logging/logger-config', () => ({ loggers: { api: { error: (...a: unknown[]) => mockLogError(...(a as [])), warn: vi.fn(), info: vi.fn() } } }));
vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({ logActivityWithTx: vi.fn(async () => undefined) }));
vi.mock('@pagespace/lib/monitoring/change-group', () => ({ inferChangeGroupType: vi.fn(() => 'edit'), createChangeGroupId: vi.fn(() => 'cg-1') }));
vi.mock('@pagespace/lib/services/page-version-service', () => ({ computePageStateHash: vi.fn(() => 'hash'), createPageVersion: vi.fn(async () => undefined) }));
vi.mock('@pagespace/lib/services/page-content-store', () => ({ writePageContent: vi.fn(async () => ({ ref: 'stored-ref' })) }));
vi.mock('@pagespace/lib/content/page-content-format', () => ({ detectPageContentFormat: vi.fn(() => 'markdown') }));
vi.mock('@pagespace/lib/utils/hash-utils', () => ({ hashWithPrefix: vi.fn(() => 'ref') }));
vi.mock('@pagespace/lib/sheets/sheet', () => ({ isSheetType: vi.fn(() => false) }));
vi.mock('@pagespace/lib/sheets/store', () => ({ replaceFromDocument: vi.fn(), readSheetDocument: vi.fn(async () => null) }));
vi.mock('@pagespace/lib/utils/enums', () => ({ PageType: { DOCUMENT: 'DOCUMENT' } }));
vi.mock('@pagespace/lib/notifications/notifications', () => ({ createMentionNotification: vi.fn(async () => undefined) }));

const { applyPageMutation } = await import('../page-mutation-service');

const baseInput = {
  pageId: 'page-1',
  operation: 'update' as const,
  updatedFields: ['content'],
  expectedRevision: 1,
  context: { userId: 'user-1' },
  source: 'user' as const,
};

describe('applyPageMutation re-anchors content tags', () => {
  beforeEach(() => {
    mockReanchor.mockClear();
    mockLogError.mockClear();
  });

  it('sweeps with BOTH revisions and the caller transaction', async () => {
    await applyPageMutation({ ...baseInput, updates: { content: 'the edited content' } } as never);

    expect(mockReanchor).toHaveBeenCalledTimes(1);
    const [pageId, oldContent, newContent, options] = mockReanchor.mock.calls[0] as unknown as [string, string, string, Record<string, unknown>];
    expect(pageId).toBe('page-1');
    expect(oldContent).toBe('the original content');
    expect(newContent).toBe('the edited content');
    // Identity check, not a truthiness check: the sweep must run on the SAME
    // transaction as the content write, not on the db singleton.
    expect(options.executor).toBe(transaction);
  });

  it('passes the PRE-update mode as the old one across a conversion', async () => {
    // The pages row is already updated when the hook runs, so a service reading
    // the stored mode would see the new one for both revisions — which projects
    // the old HTML as raw text and orphans every anchor.
    await applyPageMutation({
      ...baseInput,
      updatedFields: ['content', 'contentMode'],
      updates: { content: '# converted', contentMode: 'markdown' },
    } as never);

    const [, , , options] = mockReanchor.mock.calls[0] as unknown as [string, string, string, Record<string, unknown>];
    expect(options.oldContentMode, 'the mode the old revision was written in').toBe('html');
    expect(options.newContentMode, 'the mode the page now has').toBe('markdown');
  });

  it('does not sweep when the content did not change', async () => {
    await applyPageMutation({ ...baseInput, updatedFields: ['title'], updates: { title: 'Renamed' } } as never);
    expect(mockReanchor).not.toHaveBeenCalled();
  });

  it('logs a failed sweep instead of failing the save', async () => {
    // Degraded anchors are recoverable by a later repair pass; a refused page
    // save is not. reanchorPageTags returns a result rather than throwing, so
    // it cannot roll the caller's transaction back.
    mockReanchor.mockResolvedValueOnce({ ok: false as const, error: 'internal_error' } as never);

    await expect(
      applyPageMutation({ ...baseInput, updates: { content: 'still saves' } } as never),
    ).resolves.toBeDefined();

    expect(mockLogError).toHaveBeenCalled();
  });
});
