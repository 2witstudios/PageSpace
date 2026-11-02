/**
 * pageService.updatePage and the content lock.
 *
 * Two things are pinned here. The 409 has to tell an editor where the content
 * is now. And every update has to hold the page's row while it runs: a content
 * save no longer checks the row revision, so without the lock a rename and a
 * save could both read revision N and both write N+1, and the activity chain
 * would hold two entries claiming the same place.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { credentialActor } from '@pagespace/lib/permissions/access-actor';

const mocks = vi.hoisted(() => {
  class PageRevisionMismatchError extends Error {
    constructor(
      message: string,
      public currentRevision: number,
      public expectedRevision?: number,
      contentLock?: { current: number; expected: number | undefined }
    ) {
      super(message);
      this.currentContentRevision = contentLock?.current;
      this.expectedContentRevision = contentLock?.expected;
    }
    currentContentRevision?: number;
    expectedContentRevision?: number;
  }
  return {
    PageRevisionMismatchError,
    applyPageMutation: vi.fn(),
    lockRow: vi.fn(),
    loosen: vi.fn(),
    order: [] as string[],
    findFirstPage: vi.fn(),
  };
});

const storedPage = {
  id: 'page-1',
  title: 'Doc',
  type: 'DOCUMENT',
  content: 'text',
  contentMode: 'html',
  parentId: null,
  driveId: 'drive-1',
  position: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
  revision: 12,
  contentRevision: 7,
  stateHash: 'hash',
  isTrashed: false,
  trashedAt: null,
  aiProvider: null,
  aiModel: null,
  systemPrompt: null,
  enabledTools: null,
  isPaginated: null,
};

vi.mock('@pagespace/db/db', () => {
  const rows = () => {
    const chain: Record<string, unknown> = {};
    for (const method of ['select', 'from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'limit']) {
      chain[method] = () => chain;
    }
    chain.then = (resolve: (value: unknown[]) => unknown) => resolve([]);
    return chain;
  };
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({
          for: async (strength: string) => {
            mocks.order.push(`lock:${strength}`);
            mocks.lockRow(strength);
            return [{ isPrivate: true }];
          },
        }),
      }),
    }),
  };
  return {
    db: {
      ...rows(),
      query: {
        pages: {
          findFirst: (...args: unknown[]) => mocks.findFirstPage(...args),
          findMany: async () => [],
        },
      },
      transaction: (fn: (t: unknown) => Promise<unknown>) => fn(tx),
    },
  };
});
vi.mock('../page-mutation-service', () => ({
  applyPageMutation: (...args: unknown[]) => {
    mocks.order.push('mutate');
    return mocks.applyPageMutation(...args);
  },
  PageRevisionMismatchError: mocks.PageRevisionMismatchError,
  OrgModelPolicyError: class OrgModelPolicyError extends Error {},
}));
vi.mock('@/lib/ai/core/ai-providers-config', () => ({ DEFAULT_PROVIDER: 'p', DEFAULT_MODEL: 'm' }));
vi.mock('@/lib/ai/core/org-model-policy', () => ({ agentModelSaveRefusal: vi.fn() }));
vi.mock('@/lib/repositories/unified-message-scope', () => ({ unifiedPageScope: vi.fn(), derivedPageId: vi.fn() }));
vi.mock('../task-sync-service', () => ({ ensureTaskItemForPage: vi.fn(), ensureTaskListForPage: vi.fn() }));
vi.mock('@pagespace/lib/permissions/permissions', () => ({
  canUserViewPage: vi.fn(),
  canUserEditPage: vi.fn(async () => true),
  canUserDeletePage: vi.fn(),
  isDriveOwnerOrAdmin: vi.fn(),
  explainSignInRefusal: vi.fn(async () => null),
}));
vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  getActorInfo: vi.fn(async () => ({ actorEmail: 'a@b.c', actorDisplayName: 'A' })),
  logActivityWithTx: vi.fn(),
}));
vi.mock('@pagespace/lib/services/page-version-service', () => ({ computePageStateHash: vi.fn(), createPageVersion: vi.fn() }));
vi.mock('@pagespace/lib/pages/circular-reference-guard', () => ({ validatePageMove: vi.fn(async () => ({ valid: true })) }));
vi.mock('@pagespace/lib/memory/memory-pages', () => ({
  isProtectedMemoryPage: vi.fn(async () => false),
  MEMORY_PAGE_DELETE_ERROR: '',
  MEMORY_PAGE_MOVE_ERROR: '',
}));
vi.mock('@pagespace/lib/permissions/org-lapse-guard', () => ({
  OrgLapsedError: class OrgLapsedError extends Error {},
  checkPageMayLoosen: (...args: unknown[]) => mocks.loosen(...args),
}));
vi.mock('@pagespace/lib/sheets/sheet', () => ({ isSheetType: vi.fn(() => false) }));
vi.mock('@pagespace/lib/sheets/store', () => ({ readSheetDocument: vi.fn(async () => null) }));

const { pageService } = await import('../page-service');

const actor = credentialActor('user-1', null);

describe('pageService.updatePage content lock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.order.length = 0;
    mocks.findFirstPage.mockResolvedValue(storedPage);
    mocks.applyPageMutation.mockResolvedValue({ deferredTrigger: undefined });
    mocks.loosen.mockResolvedValue(false);
  });

  it('passes the content lock to the mutation', async () => {
    await pageService.updatePage('page-1', actor, { content: 'edited' }, { expectedContentRevision: 7 });

    expect(mocks.applyPageMutation).toHaveBeenCalledWith(
      expect.objectContaining({ expectedContentRevision: 7, expectedRevision: undefined })
    );
  });

  it.each([
    ['a content save', { content: 'edited' }],
    ['a rename', { title: 'New title' }],
    ['a move', { parentId: null }],
  ])('holds the row FOR UPDATE before the mutation reads it, for %s', async (_name, updates) => {
    await pageService.updatePage('page-1', actor, updates);

    expect(mocks.order).toEqual(['lock:update', 'mutate']);
    expect(mocks.applyPageMutation).toHaveBeenCalledWith(expect.objectContaining({ tx: expect.anything() }));
  });

  it('fires the deferred workflow trigger once the transaction has committed', async () => {
    const deferredTrigger = vi.fn();
    mocks.applyPageMutation.mockResolvedValue({ deferredTrigger });

    await pageService.updatePage('page-1', actor, { content: 'edited' });

    expect(deferredTrigger).toHaveBeenCalledTimes(1);
  });

  it('answers a stale content lock with 409 and where the content is now', async () => {
    mocks.applyPageMutation.mockRejectedValue(
      new mocks.PageRevisionMismatchError('stale', 12, undefined, { current: 7, expected: 3 })
    );

    await expect(
      pageService.updatePage('page-1', actor, { content: 'edited' }, { expectedContentRevision: 3 })
    ).resolves.toMatchObject({
      success: false,
      status: 409,
      currentRevision: 12,
      currentContentRevision: 7,
      expectedContentRevision: 3,
    });
  });

  it('still answers a stale row revision with 409', async () => {
    mocks.applyPageMutation.mockRejectedValue(new mocks.PageRevisionMismatchError('stale', 12, 5));

    await expect(
      pageService.updatePage('page-1', actor, { content: 'edited' }, { expectedRevision: 5 })
    ).resolves.toMatchObject({ success: false, status: 409, currentRevision: 12, expectedRevision: 5 });
  });

  it('still answers a write carrying no token at all with 428, under strict mode', async () => {
    mocks.applyPageMutation.mockRejectedValue(new mocks.PageRevisionMismatchError('required', 12, undefined));

    await expect(pageService.updatePage('page-1', actor, { content: 'edited' })).resolves.toMatchObject({
      success: false,
      status: 428,
    });
  });

  it('returns the content revision with the saved page', async () => {
    const result = await pageService.updatePage('page-1', actor, { content: 'edited' }, { expectedContentRevision: 7 });

    expect(result).toMatchObject({ success: true, page: { revision: 12, contentRevision: 7 } });
  });

  it('still refuses loosening a private page in a lapsed org, under the same lock', async () => {
    mocks.loosen.mockResolvedValue(true);

    await expect(pageService.updatePage('page-1', actor, { isPrivate: false })).rejects.toThrow();

    expect(mocks.lockRow).toHaveBeenCalledWith('update');
    expect(mocks.applyPageMutation).not.toHaveBeenCalled();
  });
});
