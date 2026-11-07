/**
 * `pages.contentRevision`: the lock a content save is checked against.
 *
 * WHY THIS TEST EXISTS. `pages.revision` versions the whole row, so anything
 * that wrote the row (a rename, a move, a privacy change) refused the next
 * content save with a 409, and a person editing alone was told someone else had
 * saved. These cases pin the rule that fixes it: only a real change to the
 * content moves the content lock, and only a real change to the content can be
 * refused by it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  eq: vi.fn((column: unknown, value: unknown) => ({ column, value })),
  and: vi.fn((...conditions: unknown[]) => conditions),
}));

const currentPage = {
  id: 'page-1',
  driveId: 'drive-1',
  revision: 12,
  contentRevision: 7,
  type: 'DOCUMENT',
  content: 'stored text',
  contentMode: 'html',
  title: 'Doc',
};

function queryBuilder(rows: unknown[]) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ['select', 'from', 'where', 'limit', 'update', 'set', 'returning', 'insert', 'values']) {
    chain[method] = vi.fn(() => chain);
  }
  chain.limit = vi.fn(async () => rows);
  chain.returning = vi.fn(async () => rows);
  return chain;
}

const transaction = queryBuilder([currentPage]);
transaction.transaction = vi.fn(async (fn: (sp: unknown) => Promise<unknown>) => fn({}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    ...queryBuilder([currentPage]),
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(transaction)),
  },
}));
vi.mock('@pagespace/db/operators', () => ({ eq: mocks.eq, and: mocks.and }));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'id', revision: 'revision', contentRevision: 'contentRevision' },
}));
vi.mock('@pagespace/lib/tags/tag-service', () => ({
  reanchorPageTags: vi.fn(async () => ({ ok: true, data: { considered: 0, updated: 0, orphaned: 0, newlyOrphaned: 0, repairedStaleHash: 0, repairedFormatFlip: 0 } })),
}));
vi.mock('@/services/api/page-mention-service', () => ({ syncMentions: vi.fn(async () => undefined) }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({ loggers: { api: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } } }));
vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({ logActivityWithTx: vi.fn(async () => undefined) }));
vi.mock('@pagespace/lib/monitoring/change-group', () => ({ inferChangeGroupType: vi.fn(() => 'edit'), createChangeGroupId: vi.fn(() => 'cg-1') }));
vi.mock('@pagespace/lib/services/page-version-service', () => ({ computePageStateHash: vi.fn(() => 'hash'), createPageVersion: vi.fn(async () => undefined) }));
vi.mock('@pagespace/lib/services/page-content-store', () => ({ writePageContent: vi.fn(async () => ({ ref: 'stored-ref', size: 1 })) }));
vi.mock('@pagespace/lib/content/page-content-format', () => ({ detectPageContentFormat: vi.fn(() => 'html') }));
vi.mock('@pagespace/lib/utils/hash-utils', () => ({ hashWithPrefix: vi.fn(() => 'ref') }));
vi.mock('@pagespace/lib/sheets/sheet', () => ({ isSheetType: vi.fn(() => false) }));
vi.mock('@pagespace/lib/sheets/store', () => ({ replaceFromDocument: vi.fn(), readSheetDocument: vi.fn(async () => null) }));
vi.mock('@pagespace/lib/utils/enums', () => ({ PageType: { DOCUMENT: 'DOCUMENT' } }));
vi.mock('@pagespace/lib/notifications/notifications', () => ({ createMentionNotification: vi.fn(async () => undefined) }));
vi.mock('@/lib/ai/core/org-model-policy', () => ({ agentModelSaveRefusal: vi.fn(async () => ({ ok: true })) }));

const { applyPageMutation, PageRevisionMismatchError } = await import('../page-mutation-service');

const mutate = (input: { updates: Record<string, unknown>; expectedRevision?: number; expectedContentRevision?: number }) =>
  applyPageMutation({
    pageId: 'page-1',
    operation: 'update',
    context: { userId: 'user-1' },
    ...input,
  });

/** What the mutation wrote to the row. */
const written = () => transaction.set.mock.calls[0]?.[0] as Record<string, unknown> | undefined;

describe('applyPageMutation content revision', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('what moves the content lock', () => {
    it.each([
      ['a rename', { title: 'New title' }],
      ['a move', { parentId: 'parent-2' }],
      ['a privacy change', { isPrivate: true }],
    ])('leaves it alone for %s, while the row revision still moves', async (_name, updates) => {
      await mutate({ updates });

      expect(written()).toMatchObject({ revision: 13 });
      expect(written()).not.toHaveProperty('contentRevision');
    });

    it('moves it for changed content', async () => {
      await mutate({ updates: { content: 'edited text' } });

      expect(written()).toMatchObject({ revision: 13, contentRevision: 8 });
    });

    it('moves it for a changed content mode, which changes what the content means', async () => {
      await mutate({ updates: { contentMode: 'markdown' } });

      expect(written()).toMatchObject({ contentRevision: 8 });
    });

    it('leaves it alone when the content written is what is already stored', async () => {
      await mutate({ updates: { content: 'stored text', title: 'New title' } });

      expect(written()).not.toHaveProperty('contentRevision');
    });
  });

  describe('expectedContentRevision', () => {
    it('refuses changed content against a stale lock, and writes nothing', async () => {
      const refused = await mutate({
        updates: { content: 'edited text' },
        expectedContentRevision: 3,
      }).catch((error: unknown) => error);

      expect(refused).toBeInstanceOf(PageRevisionMismatchError);
      expect(refused).toMatchObject({
        currentRevision: 12,
        expectedRevision: undefined,
        currentContentRevision: 7,
        expectedContentRevision: 3,
      });
      expect(transaction.update).not.toHaveBeenCalled();
    });

    it('accepts changed content against the current lock, and guards the write with it', async () => {
      await mutate({ updates: { content: 'edited text' }, expectedContentRevision: 7 });

      expect(written()).toMatchObject({ contentRevision: 8 });
      expect(mocks.eq).toHaveBeenCalledWith('contentRevision', 7);
    });

    it('does not refuse a save after a rename moved only the row revision', async () => {
      // The row is at 12, as if renamed; the editor still holds content lock 7.
      await expect(
        mutate({ updates: { content: 'edited text' }, expectedContentRevision: 7 })
      ).resolves.toMatchObject({ nextRevision: 13 });
    });

    it('applies the other fields when a stale save carries the content already stored', async () => {
      await mutate({
        updates: { content: 'stored text', title: 'New title' },
        expectedContentRevision: 3,
      });

      expect(written()).toMatchObject({ title: 'New title', revision: 13 });
      expect(written()).not.toHaveProperty('contentRevision');
    });

    it('does not guard the write when no content changes, so nothing can be refused late', async () => {
      await mutate({
        updates: { content: 'stored text', title: 'New title' },
        expectedContentRevision: 3,
      });

      expect(mocks.eq).not.toHaveBeenCalledWith('contentRevision', expect.anything());
    });

    it('writes nothing when a resend carries the stored content and nothing else', async () => {
      const result = await mutate({
        updates: { content: 'stored text' },
        expectedContentRevision: 3,
      });

      expect(transaction.update).not.toHaveBeenCalled();
      expect(result).toMatchObject({ pageId: 'page-1', nextRevision: 12 });
    });

    it('is not consulted for a write that carries no content', async () => {
      await expect(
        mutate({ updates: { title: 'New title' }, expectedContentRevision: 3 })
      ).resolves.toMatchObject({ nextRevision: 13 });
    });
  });

  describe('expectedRevision', () => {
    it('still refuses a stale row revision, for callers that use it', async () => {
      await expect(
        mutate({ updates: { content: 'edited text' }, expectedRevision: 5 })
      ).rejects.toMatchObject({ currentRevision: 12, expectedRevision: 5 });
    });

    it('still guards the write with the row revision', async () => {
      await mutate({ updates: { title: 'New title' }, expectedRevision: 12 });

      expect(mocks.eq).toHaveBeenCalledWith('revision', 12);
    });
  });

  describe('PAGE_REVISION_STRICT', () => {
    const loadStrict = async () => {
      vi.stubEnv('PAGE_REVISION_STRICT', 'true');
      vi.resetModules();
      return import('../page-mutation-service');
    };

    it('accepts a content lock in place of a row revision', async () => {
      const strict = await loadStrict();

      await expect(
        strict.applyPageMutation({
          pageId: 'page-1',
          operation: 'update',
          context: { userId: 'user-1' },
          updates: { content: 'edited text' },
          expectedContentRevision: 7,
        })
      ).resolves.toMatchObject({ nextRevision: 13 });
      vi.unstubAllEnvs();
    });

    it('still refuses a write carrying neither', async () => {
      const strict = await loadStrict();

      await expect(
        strict.applyPageMutation({
          pageId: 'page-1',
          operation: 'update',
          context: { userId: 'user-1' },
          updates: { content: 'edited text' },
        })
      ).rejects.toThrow('Expected revision required');
      vi.unstubAllEnvs();
    });
  });
});
