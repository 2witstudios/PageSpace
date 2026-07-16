import { describe, it, vi, expect } from 'vitest';
import { assert } from '@/stores/__tests__/riteway';

// applyPageUpdateWithRevision pulls computePageMutation -> computePageStateHash,
// whose module imports the db connection at load time. Stub the real connection;
// the shell uses the injected deps.db, not this one.
vi.mock('@pagespace/db/db', () => ({ db: {} }));
vi.mock('@pagespace/db/schema/core', () => ({ pages: { id: 'id' } }));

import { applyPageUpdateWithRevision } from '../page-mutation';
import type { RollbackDeps } from '../deps';

function currentPageRow() {
  return {
    id: 'page_1', revision: 3, content: 'BEFORE', title: 'T', parentId: null, position: 0,
    isTrashed: false, type: 'DOCUMENT', driveId: 'drive_1', aiProvider: null, aiModel: null,
    systemPrompt: null, enabledTools: null, isPaginated: false, includeDrivePrompt: false,
    agentDefinition: null, visibleToGlobalAssistant: false, includePageTree: false,
    pageTreeScope: null, userScopedAccess: false,
  };
}

function makeDeps(opts: { selectRows: unknown[]; updateRows: unknown[] }): { deps: RollbackDeps; syncMentions: ReturnType<typeof vi.fn>; createPageVersion: ReturnType<typeof vi.fn> } {
  const syncMentions = vi.fn().mockResolvedValue({ mentionedByUserId: 'u', sourcePageId: 'page_1', newlyMentionedUserIds: [] });
  const createPageVersion = vi.fn().mockResolvedValue({ contentRef: 'ref_after', contentSize: 42 });
  const fakeDb = {
    select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve(opts.selectRows) }) }) }),
    update: () => ({ set: () => ({ where: () => ({ returning: () => Promise.resolve(opts.updateRows) }) }) }),
  } as unknown as RollbackDeps['db'];
  const deps = {
    db: fakeDb,
    clock: () => new Date('2024-01-01T00:00:00.000Z'),
    genChangeGroupId: () => 'cg_1',
    inferChangeGroupType: () => 'user_edit',
    readContent: vi.fn(),
    syncMentions,
    createPageVersion,
    getActorInfo: vi.fn(),
    logRollbackActivity: vi.fn(),
    canUserRollback: vi.fn(),
    isRollbackableOperation: vi.fn(),
    createMentionNotification: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as RollbackDeps;
  return { deps, syncMentions, createPageVersion };
}

describe('applyPageUpdateWithRevision (DI shell)', () => {
  it('throws when the page no longer exists', async () => {
    const { deps } = makeDeps({ selectRows: [], updateRows: [] });
    let message = 'NO THROW';
    try {
      await applyPageUpdateWithRevision(deps, 'page_1', { title: 'X' });
    } catch (e) {
      message = (e as Error).message;
    }
    assert({ given: 'no current page row', should: 'throw Page not found', actual: message, expected: 'Page not found' });
  });

  it('throws when a concurrent edit bumped the revision (revision-guarded write returns nothing)', async () => {
    const { deps } = makeDeps({ selectRows: [currentPageRow()], updateRows: [] });
    let message = 'NO THROW';
    try {
      await applyPageUpdateWithRevision(deps, 'page_1', { title: 'X' });
    } catch (e) {
      message = (e as Error).message;
    }
    assert({
      given: 'the revision-guarded update returning no row',
      should: 'throw "Page was modified while applying rollback"',
      actual: message,
      expected: 'Page was modified while applying rollback',
    });
  });

  it('returns mutation meta with the incremented revision on success', async () => {
    const { deps } = makeDeps({ selectRows: [currentPageRow()], updateRows: [{ id: 'page_1' }] });
    const meta = await applyPageUpdateWithRevision(deps, 'page_1', { title: 'X' });
    assert({
      given: 'a successful revision-guarded write',
      should: 'return the incremented revision and version contentRef/size',
      actual: { nextRevision: meta.nextRevision, contentRefAfter: meta.contentRefAfter, contentSizeAfter: meta.contentSizeAfter },
      expected: { nextRevision: 4, contentRefAfter: 'ref_after', contentSizeAfter: 42 },
    });
  });

  it('syncs mentions only when content is part of the update', async () => {
    const withContent = makeDeps({ selectRows: [currentPageRow()], updateRows: [{ id: 'page_1' }] });
    await applyPageUpdateWithRevision(withContent.deps, 'page_1', { content: 'NEW' });
    const withoutContent = makeDeps({ selectRows: [currentPageRow()], updateRows: [{ id: 'page_1' }] });
    await applyPageUpdateWithRevision(withoutContent.deps, 'page_1', { title: 'X' });
    expect(withContent.syncMentions).toHaveBeenCalledTimes(1);
    assert({
      given: 'an update with content vs without',
      should: 'call syncMentions for content and skip it otherwise',
      actual: withoutContent.syncMentions.mock.calls.length,
      expected: 0,
    });
  });
});
