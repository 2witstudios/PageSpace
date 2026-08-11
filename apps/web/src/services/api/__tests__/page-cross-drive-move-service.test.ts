/**
 * Unit tests for movePagesToDrive — the shared cross-drive move implementation
 * behind POST /api/pages/bulk-move and the AI `move_page` tool.
 *
 * Focus areas the route-level contract test cannot reach directly:
 * - the authorizer contract (which question is asked, about WHICH drive, in what
 *   order, and where it short-circuits)
 * - the descendant cascade (batching, cycle termination, depth ceiling)
 * - the home-page invariant, positions and activity attribution
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mocks (before imports) ──────────────────────────────────────────────

// Real refusal string kept, so a reworded constant cannot pass silently.
vi.mock('@pagespace/lib/memory/memory-pages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pagespace/lib/memory/memory-pages')>();
  return { ...actual, findProtectedMemoryPages: vi.fn().mockResolvedValue(new Set<string>()) };
});

vi.mock('@pagespace/lib/pages/circular-reference-guard', () => ({
  validatePageMove: vi.fn().mockResolvedValue({ valid: true }),
}));

vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  getActorInfo: vi.fn().mockResolvedValue({
    actorEmail: 'test@example.com',
    actorDisplayName: 'Test User',
  }),
  logPageActivity: vi.fn(),
}));

vi.mock('@pagespace/lib/monitoring/change-group', () => ({
  createChangeGroupId: vi.fn(() => 'change-group-123'),
}));

vi.mock('@/services/api/task-sync-service', () => ({
  syncTaskItemOnMove: vi.fn().mockResolvedValue(undefined),
  scrubDriveScopedTaskAssociations: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@pagespace/db/db', () => {
  const txUpdateWhere = vi.fn().mockResolvedValue(undefined);
  const txUpdateSet = vi.fn().mockReturnValue({ where: txUpdateWhere });
  const txUpdate = vi.fn().mockReturnValue({ set: txUpdateSet });
  const txQueryPagesFindMany = vi.fn().mockResolvedValue([]);
  const txQueryPagesFindFirst = vi.fn().mockResolvedValue(undefined);
  const txQueryDrivesFindFirst = vi.fn().mockResolvedValue(undefined);
  const tx = {
    update: txUpdate,
    query: {
      pages: { findMany: txQueryPagesFindMany, findFirst: txQueryPagesFindFirst },
      drives: { findFirst: txQueryDrivesFindFirst },
    },
  };
  const transaction = vi.fn(async (fn: (t: unknown) => Promise<void>) => {
    await fn(tx);
  });
  return {
    db: {
      query: {
        drives: { findFirst: vi.fn() },
        pages: { findFirst: vi.fn(), findMany: vi.fn() },
      },
      transaction,
    },
    __test__: {
      txUpdate,
      txUpdateSet,
      txUpdateWhere,
      txQueryPagesFindMany,
      txQueryPagesFindFirst,
      txQueryDrivesFindFirst,
      transaction,
    },
  };
});

vi.mock('@pagespace/db/operators', () => ({
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((a: unknown, b: unknown) => [a, b]),
  inArray: vi.fn((a: unknown, b: unknown) => ({ _inArray: true, col: a, values: b })),
  desc: vi.fn((a: unknown) => a),
  isNull: vi.fn((a: unknown) => a),
}));

vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'id', driveId: 'driveId', parentId: 'parentId', position: 'position', isTrashed: 'isTrashed' },
  drives: { id: 'id' },
}));

// ── Imports (after mocks) ───────────────────────────────────────────────

import { movePagesToDrive, MAX_SUBTREE_DEPTH } from '../page-cross-drive-move-service';
import { validatePageMove } from '@pagespace/lib/pages/circular-reference-guard';
import {
  findProtectedMemoryPages,
  MEMORY_PAGE_MOVE_ERROR,
} from '@pagespace/lib/memory/memory-pages';
import { logPageActivity } from '@pagespace/lib/monitoring/activity-logger';
import { scrubDriveScopedTaskAssociations } from '@/services/api/task-sync-service';
// @ts-expect-error - accessing test-only export
import { db, __test__ as dbTest } from '@pagespace/db/db';

const {
  txUpdate,
  txUpdateSet,
  txQueryPagesFindMany,
  txQueryPagesFindFirst,
  txQueryDrivesFindFirst,
  transaction: mockTransaction,
} = dbTest as Record<string, ReturnType<typeof vi.fn>>;

// ── Helpers ─────────────────────────────────────────────────────────────

const USER_ID = 'user_123';
const TARGET_DRIVE = 'drive_target';
const SOURCE_DRIVE = 'drive_source';

const sourcePage = (overrides: Record<string, unknown> = {}) => ({
  id: 'page-1',
  title: 'Source Page',
  type: 'DOCUMENT',
  driveId: SOURCE_DRIVE,
  parentId: null,
  position: 1,
  isTrashed: false,
  ...overrides,
});

const makeAuthorizer = (overrides: Record<string, unknown> = {}) => ({
  isDriveInScope: vi.fn().mockReturnValue(true),
  canAdministerDrive: vi.fn().mockResolvedValue(true),
  canEditPage: vi.fn().mockResolvedValue(true),
  ...overrides,
});

const run = (
  params: Partial<Parameters<typeof movePagesToDrive>[0]> = {},
  authorize = makeAuthorizer(),
) =>
  movePagesToDrive({
    pageIds: ['page-1'],
    targetDriveId: TARGET_DRIVE,
    targetParentId: null,
    userId: USER_ID,
    authorize: authorize as never,
    ...params,
  });

function setupSuccessScenario() {
  vi.mocked(db.query.drives.findFirst).mockResolvedValue({ id: TARGET_DRIVE } as never);
  vi.mocked(db.query.pages.findMany).mockResolvedValue([sourcePage()] as never);
  vi.mocked(db.query.pages.findFirst).mockResolvedValue({ position: 5 } as never);
  vi.mocked(validatePageMove).mockResolvedValue({ valid: true });
  vi.mocked(findProtectedMemoryPages).mockResolvedValue(new Set<string>());

  const txUpdateWhere = vi.fn().mockResolvedValue(undefined);
  txUpdateSet.mockReturnValue({ where: txUpdateWhere });
  txUpdate.mockReturnValue({ set: txUpdateSet });
  txQueryPagesFindMany.mockResolvedValue([]);
  txQueryPagesFindFirst.mockResolvedValue(undefined);
  txQueryDrivesFindFirst.mockResolvedValue(undefined);
  mockTransaction.mockImplementation(async (fn: (t: unknown) => Promise<void>) => {
    await fn({
      update: txUpdate,
      query: {
        pages: { findMany: txQueryPagesFindMany, findFirst: txQueryPagesFindFirst },
        drives: { findFirst: txQueryDrivesFindFirst },
      },
    });
  });
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('movePagesToDrive', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupSuccessScenario();
  });

  // ── Memory page protection ────────────────────────────────────────────

  describe('memory page protection', () => {
    it('refuses to move a memory page to another drive', async () => {
      // This service is the ONLY cross-drive move path, shared by
      // /api/pages/bulk-move and the AI move_page tool. pageService.updatePage's
      // guard never runs here, so without this the REST route could relocate a
      // memory page out of the Home drive its pointers assume.
      vi.mocked(findProtectedMemoryPages).mockResolvedValue(new Set(['page-1']));

      const result = await run();

      expect(result.success).toBe(false);
      if (result.success) throw new Error('expected refusal');
      expect(result.code).toBe('MEMORY_PAGE_PROTECTED');
      expect(result.status).toBe(403);
      expect(result.message).toBe(MEMORY_PAGE_MOVE_ERROR);

      // Refused before the write, not rolled back after one.
      expect(mockTransaction).not.toHaveBeenCalled();
    });

    it('refuses the whole batch when only one page is protected', async () => {
      vi.mocked(db.query.pages.findMany).mockResolvedValue([
        sourcePage({ id: 'page-1' }),
        sourcePage({ id: 'memory-bio' }),
      ] as never);
      vi.mocked(findProtectedMemoryPages).mockResolvedValue(new Set(['memory-bio']));

      const result = await run({ pageIds: ['page-1', 'memory-bio'] });

      expect(result.success).toBe(false);
      expect(mockTransaction).not.toHaveBeenCalled();
    });

    it('checks permission before revealing that a page is a memory page', async () => {
      // A caller who cannot edit the source page must not learn what it holds.
      vi.mocked(findProtectedMemoryPages).mockResolvedValue(new Set(['page-1']));
      const authorize = makeAuthorizer({ canEditPage: vi.fn().mockResolvedValue(false) });

      const result = await run({}, authorize);

      expect(result.success).toBe(false);
      if (result.success) throw new Error('expected refusal');
      expect(result.code).toBe('SOURCE_PAGE_FORBIDDEN');
      expect(findProtectedMemoryPages).not.toHaveBeenCalled();
    });
  });

  // ── Authorizer contract ───────────────────────────────────────────────

  describe('authorizer contract', () => {
    it('asks canAdministerDrive exactly once, about the TARGET drive only', async () => {
      const authorize = makeAuthorizer();

      await run({}, authorize);

      expect(authorize.canAdministerDrive).toHaveBeenCalledTimes(1);
      expect(authorize.canAdministerDrive).toHaveBeenCalledWith(TARGET_DRIVE);
      // The whole point of the chosen bar: source-drive administration is never required.
      expect(authorize.canAdministerDrive).not.toHaveBeenCalledWith(SOURCE_DRIVE);
    });

    it('asks canEditPage once per source page, in order', async () => {
      vi.mocked(db.query.pages.findMany).mockResolvedValue([
        sourcePage({ id: 'page-1' }),
        sourcePage({ id: 'page-2' }),
      ] as never);
      const authorize = makeAuthorizer();

      await run({ pageIds: ['page-1', 'page-2'] }, authorize);

      expect(authorize.canEditPage).toHaveBeenCalledTimes(2);
      expect(authorize.canEditPage.mock.calls.map((c) => c[0])).toEqual(['page-1', 'page-2']);
    });

    it('fails with SOURCE_PAGE_FORBIDDEN naming the page, without opening a transaction', async () => {
      vi.mocked(db.query.pages.findMany).mockResolvedValue([
        sourcePage({ title: 'Protected Doc' }),
      ] as never);
      const authorize = makeAuthorizer({ canEditPage: vi.fn().mockResolvedValue(false) });

      const result = await run({}, authorize);

      expect(result).toMatchObject({ success: false, code: 'SOURCE_PAGE_FORBIDDEN', status: 403 });
      expect(result.success === false && result.message).toContain('Protected Doc');
      expect(mockTransaction).not.toHaveBeenCalled();
    });

    it('short-circuits at the destination: canEditPage is never asked when canAdministerDrive denies', async () => {
      const authorize = makeAuthorizer({ canAdministerDrive: vi.fn().mockResolvedValue(false) });

      const result = await run({}, authorize);

      expect(result).toMatchObject({ success: false, code: 'TARGET_DRIVE_FORBIDDEN', status: 403 });
      expect(authorize.canEditPage).not.toHaveBeenCalled();
      expect(mockTransaction).not.toHaveBeenCalled();
    });

    it('fails with SOURCE_DRIVE_OUT_OF_SCOPE when a source drive is outside token scope', async () => {
      const authorize = makeAuthorizer({
        isDriveInScope: vi.fn((driveId: string) => driveId !== SOURCE_DRIVE),
      });

      const result = await run({}, authorize);

      expect(result).toMatchObject({ success: false, code: 'SOURCE_DRIVE_OUT_OF_SCOPE', status: 403 });
      expect(mockTransaction).not.toHaveBeenCalled();
    });

    it('fails with TARGET_DRIVE_OUT_OF_SCOPE before asking canAdministerDrive', async () => {
      const authorize = makeAuthorizer({
        isDriveInScope: vi.fn((driveId: string) => driveId !== TARGET_DRIVE),
      });

      const result = await run({}, authorize);

      expect(result).toMatchObject({ success: false, code: 'TARGET_DRIVE_OUT_OF_SCOPE', status: 403 });
      expect(authorize.canAdministerDrive).not.toHaveBeenCalled();
    });

    it('fails with TARGET_DRIVE_NOT_FOUND when the destination does not exist', async () => {
      vi.mocked(db.query.drives.findFirst).mockResolvedValue(undefined as never);

      const result = await run();

      expect(result).toMatchObject({ success: false, code: 'TARGET_DRIVE_NOT_FOUND', status: 404 });
    });

    it('fails with TARGET_PARENT_NOT_FOUND when the parent is not in the target drive', async () => {
      vi.mocked(db.query.pages.findFirst).mockResolvedValue(undefined as never);

      const result = await run({ targetParentId: 'nope' });

      expect(result).toMatchObject({ success: false, code: 'TARGET_PARENT_NOT_FOUND', status: 404 });
    });

    it('fails with SOURCE_PAGES_NOT_FOUND when a requested page is missing', async () => {
      vi.mocked(db.query.pages.findMany).mockResolvedValue([] as never);

      const result = await run();

      expect(result).toMatchObject({ success: false, code: 'SOURCE_PAGES_NOT_FOUND', status: 404 });
    });

    it('fails with CIRCULAR_REFERENCE and never opens a transaction', async () => {
      vi.mocked(db.query.pages.findFirst).mockResolvedValue({ id: 'target-parent', position: 3 } as never);
      vi.mocked(validatePageMove).mockResolvedValue({
        valid: false,
        error: 'Cannot set parent: would create circular reference in page tree',
      });

      const result = await run({ targetParentId: 'target-parent' });

      expect(result).toMatchObject({ success: false, code: 'CIRCULAR_REFERENCE', status: 400 });
      expect(mockTransaction).not.toHaveBeenCalled();
    });
  });

  // ── Descendant cascade ────────────────────────────────────────────────

  describe('descendant cascade', () => {
    it('rewrites each level in a single batched update and counts descendants', async () => {
      txQueryPagesFindMany
        .mockResolvedValueOnce([{ id: 'child-1' }, { id: 'child-2' }])
        .mockResolvedValueOnce([{ id: 'grandchild-1' }])
        .mockResolvedValue([]);

      const result = await run();

      expect(result).toMatchObject({ success: true, descendantCount: 3 });
      // 1 root move + 1 batch for level 1 + 1 batch for level 2
      expect(txUpdate).toHaveBeenCalledTimes(3);
    });

    it('terminates on a parentId cycle, updating each node exactly once', async () => {
      // page-1 → child-1 → page-1 (a cycle the old recursive walk would follow forever)
      txQueryPagesFindMany
        .mockResolvedValueOnce([{ id: 'child-1' }])
        .mockResolvedValueOnce([{ id: 'page-1' }])
        .mockResolvedValue([]);

      const result = await run();

      expect(result).toMatchObject({ success: true, descendantCount: 1 });
      // 1 root move + 1 batch for child-1; page-1 is already in `visited`.
      expect(txUpdate).toHaveBeenCalledTimes(2);
    });

    it('returns SUBTREE_TOO_DEEP as a result rather than throwing out of the transaction', async () => {
      // Every level yields one fresh node, so the walk only stops at the depth cap.
      let counter = 0;
      txQueryPagesFindMany.mockImplementation(async () => [{ id: `deep-${counter++}` }]);

      const result = await run();

      expect(result).toMatchObject({ success: false, code: 'SUBTREE_TOO_DEEP', status: 400 });
      expect(result.success === false && result.message).toContain(String(MAX_SUBTREE_DEPTH));
    });

    // Boundary: the cap exists to catch a parentId cycle, not to reject deep
    // trees. Firing it one level early would roll back a move in which every
    // node had already been rewritten — the worst possible moment to abort.
    it('migrates a subtree exactly MAX_SUBTREE_DEPTH levels deep in full', async () => {
      let level = 0;
      txQueryPagesFindMany.mockImplementation(async () =>
        level < MAX_SUBTREE_DEPTH ? [{ id: `deep-${level++}` }] : [],
      );

      const result = await run();

      expect(result).toMatchObject({ success: true, descendantCount: MAX_SUBTREE_DEPTH });
    });

    it('rejects one level deeper than the cap', async () => {
      let level = 0;
      txQueryPagesFindMany.mockImplementation(async () =>
        level < MAX_SUBTREE_DEPTH + 1 ? [{ id: `deep-${level++}` }] : [],
      );

      const result = await run();

      expect(result).toMatchObject({ success: false, code: 'SUBTREE_TOO_DEEP' });
    });

    it('does not walk the tree at all when the page already lives in the target drive', async () => {
      vi.mocked(db.query.pages.findMany).mockResolvedValue([
        sourcePage({ driveId: TARGET_DRIVE }),
      ] as never);

      const result = await run();

      expect(result).toMatchObject({ success: true, descendantCount: 0 });
      expect(txQueryPagesFindMany).not.toHaveBeenCalled();
      expect(txUpdate).toHaveBeenCalledTimes(1);
    });

    it('does not re-drive a source page that is a descendant of another source page', async () => {
      vi.mocked(db.query.pages.findMany).mockResolvedValue([
        sourcePage({ id: 'parent-page' }),
        sourcePage({ id: 'child-page' }),
      ] as never);
      // The first cascade level returns a page that is itself a move root.
      txQueryPagesFindMany.mockResolvedValueOnce([{ id: 'child-page' }]).mockResolvedValue([]);

      const result = await run({ pageIds: ['parent-page', 'child-page'] });

      expect(result).toMatchObject({ success: true, descendantCount: 0 });
      // 2 root moves only — no cascade batch, because the sole child was a seeded root.
      expect(txUpdate).toHaveBeenCalledTimes(2);
    });

    it('includes trashed descendants (no isTrashed predicate on the walk)', async () => {
      txQueryPagesFindMany.mockResolvedValueOnce([{ id: 'trashed-child' }]).mockResolvedValue([]);

      await run();

      const walkArgs = txQueryPagesFindMany.mock.calls[0][0];
      expect(JSON.stringify(walkArgs)).not.toContain('isTrashed');
    });
  });

  describe('drive-scoped task associations', () => {
    // Nothing previously asserted this wiring, so removing the call would have
    // reverted the behavior with the suite still green.
    it('scrubs the moved roots AND every cascaded descendant', async () => {
      txQueryPagesFindMany
        .mockResolvedValueOnce([{ id: 'child-1' }])
        .mockResolvedValueOnce([{ id: 'grandchild-1' }])
        .mockResolvedValue([]);

      await run();

      expect(scrubDriveScopedTaskAssociations).toHaveBeenCalledWith(
        expect.anything(),
        { pageIds: ['page-1', 'child-1', 'grandchild-1'], targetDriveId: TARGET_DRIVE },
      );
    });

    // A same-drive bulk-move never crosses a boundary, so nothing is drive-stale.
    it('does not scrub when the page already lives in the target drive', async () => {
      vi.mocked(db.query.pages.findMany).mockResolvedValue([
        sourcePage({ driveId: TARGET_DRIVE }),
      ] as never);

      await run();

      expect(scrubDriveScopedTaskAssociations).not.toHaveBeenCalled();
    });
  });

  // ── Home page invariant ───────────────────────────────────────────────

  describe('home page invariant', () => {
    it('clears homePageId when the home page leaves the source drive', async () => {
      txQueryDrivesFindFirst.mockResolvedValue({ homePageId: 'page-1' });
      txQueryPagesFindFirst.mockResolvedValue(undefined);

      const result = await run();

      expect(txUpdateSet).toHaveBeenCalledWith({ homePageId: null });
      expect(result.success === true && result.clearedHomePageDriveIds).toEqual([SOURCE_DRIVE]);
    });

    it('clears homePageId when the home page leaves as a DESCENDANT of the moved subtree', async () => {
      // The home page is not a move root — it goes along with the cascade.
      txQueryPagesFindMany.mockResolvedValueOnce([{ id: 'home-child' }]).mockResolvedValue([]);
      txQueryDrivesFindFirst.mockResolvedValue({ homePageId: 'home-child' });
      txQueryPagesFindFirst.mockResolvedValue(undefined);

      const result = await run();

      expect(result.success === true && result.clearedHomePageDriveIds).toEqual([SOURCE_DRIVE]);
    });

    it('leaves homePageId untouched when the home page stays put', async () => {
      txQueryDrivesFindFirst.mockResolvedValue({ homePageId: 'page-still-here' });
      txQueryPagesFindFirst.mockResolvedValue({ id: 'page-still-here' });

      const result = await run();

      expect(txUpdateSet).not.toHaveBeenCalledWith({ homePageId: null });
      expect(result.success === true && result.clearedHomePageDriveIds).toEqual([]);
    });
  });

  // ── Positions, result shape and activity ──────────────────────────────

  describe('positions and result', () => {
    it('appends after the last page in the target parent', async () => {
      vi.mocked(db.query.pages.findFirst).mockResolvedValue({ position: 10 } as never);

      const result = await run();

      expect(txUpdateSet.mock.calls[0][0].position).toBe(11);
      expect(result.success === true && result.moved[0].position).toBe(11);
    });

    it('starts at position 1 when the target parent is empty', async () => {
      vi.mocked(db.query.pages.findFirst).mockResolvedValue(undefined as never);

      await run();

      expect(txUpdateSet.mock.calls[0][0].position).toBe(1);
    });

    it('reports every affected drive — target and all sources', async () => {
      vi.mocked(db.query.pages.findMany).mockResolvedValue([
        sourcePage({ id: 'page-1', driveId: 'drive-a' }),
        sourcePage({ id: 'page-2', driveId: 'drive-b' }),
      ] as never);

      const result = await run({ pageIds: ['page-1', 'page-2'] });

      expect(result.success === true && result.affectedDriveIds.sort()).toEqual(
        [TARGET_DRIVE, 'drive-a', 'drive-b'].sort(),
      );
    });

    it('returns the previous location so the caller can explain or undo the move', async () => {
      const result = await run();

      expect(result.success === true && result.moved[0]).toMatchObject({
        id: 'page-1',
        title: 'Source Page',
        previousDriveId: SOURCE_DRIVE,
        previousParentId: null,
      });
    });
  });

  describe('activity', () => {
    it('logs a move per page with drive transition and one shared change group', async () => {
      vi.mocked(db.query.pages.findMany).mockResolvedValue([
        sourcePage({ id: 'page-1' }),
        sourcePage({ id: 'page-2' }),
      ] as never);

      await run({ pageIds: ['page-1', 'page-2'] });

      expect(logPageActivity).toHaveBeenCalledTimes(2);
      expect(logPageActivity).toHaveBeenCalledWith(
        USER_ID,
        'move',
        expect.objectContaining({ id: 'page-1', driveId: TARGET_DRIVE }),
        expect.objectContaining({
          changeGroupId: 'change-group-123',
          updatedFields: ['driveId', 'parentId', 'position'],
          previousValues: { driveId: SOURCE_DRIVE, parentId: null },
          newValues: { driveId: TARGET_DRIVE, parentId: null },
        }),
      );
    });

    it('threads AI attribution through the shared seam', async () => {
      await run({
        activity: {
          isAiGenerated: true,
          aiProvider: 'openrouter',
          aiModel: 'claude-opus-5',
          aiConversationId: 'conv-1',
          changeGroupType: 'ai',
          metadata: { crossDriveMove: true },
        },
      });

      expect(logPageActivity).toHaveBeenCalledWith(
        USER_ID,
        'move',
        expect.anything(),
        expect.objectContaining({
          isAiGenerated: true,
          aiProvider: 'openrouter',
          aiModel: 'claude-opus-5',
          aiConversationId: 'conv-1',
          changeGroupType: 'ai',
          metadata: expect.objectContaining({ crossDriveMove: true }),
        }),
      );
    });

    it('defaults changeGroupType to user when no activity options are given', async () => {
      await run();

      expect(logPageActivity).toHaveBeenCalledWith(
        USER_ID,
        'move',
        expect.anything(),
        expect.objectContaining({ changeGroupType: 'user' }),
      );
    });
  });

  describe('error propagation', () => {
    it('lets a genuine transaction failure escape (the route maps it to a 500)', async () => {
      mockTransaction.mockRejectedValueOnce(new Error('Database error'));

      await expect(run()).rejects.toThrow('Database error');
    });
  });
});
