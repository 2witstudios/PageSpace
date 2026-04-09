/**
 * @scaffold — version-resolver uses a module-level `db` import from
 * @pagespace/db with no injected seam. Chain mocks are unavoidable here —
 * the db mock captures the select chain that the module calls internally.
 * Assertions focus on observable return values, not call tracking.
 *
 * REVIEW: introduce a VersionRepository seam (accepting db as a parameter
 * or using dependency injection) so these tests can mock at the repository
 * boundary instead of reproducing the ORM chain shape.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@pagespace/db', () => ({
  db: {
    select: vi.fn(),
  },
  pageVersions: {
    id: 'id',
    pageId: 'pageId',
    contentRef: 'contentRef',
    pageRevision: 'pageRevision',
    changeGroupId: 'changeGroupId',
  },
  eq: vi.fn((a: unknown, b: unknown) => ({ _op: 'eq', field: a, value: b })),
  and: vi.fn((...args: unknown[]) => ({ _op: 'and', conditions: args })),
  or: vi.fn((...args: unknown[]) => ({ _op: 'or', conditions: args })),
  desc: vi.fn((field: unknown) => ({ _op: 'desc', field })),
}));

import {
  resolveVersionContent,
  batchResolveVersionContent,
  resolveStackedVersionContent,
  type VersionResolveRequest,
} from '../version-resolver';
import { db } from '@pagespace/db';

describe('version-resolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Wire db.select to resolve with `rows` at the end of the
   * `.limit()` chain. Only the single-item path uses this helper;
   * the batch path has its own `setupBatchSelectMock`.
   */
  function setupSelectMock(rows: unknown[]) {
    const limit = vi.fn().mockResolvedValue(rows);
    const mockSelect = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit,
          }),
        }),
      }),
    });
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(mockSelect);
  }

  function setupBatchSelectMock(rows: unknown[]) {
    const mockSelect = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockResolvedValue(rows),
        }),
      }),
    });
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(mockSelect);
  }

  describe('resolveVersionContent', () => {
    it('given_noVersionFound_returnsNull', async () => {
      setupSelectMock([]);

      const result = await resolveVersionContent({
        pageId: 'page1',
        changeGroupId: 'cg1',
      });

      expect(result).toBeNull();
    });

    it('given_versionFound_returnsContentPairWithCorrectRefs', async () => {
      setupSelectMock([{
        id: 'v1',
        pageId: 'page1',
        contentRef: 'afterRef',
        pageRevision: 5,
        changeGroupId: 'cg1',
      }]);

      const result = await resolveVersionContent({
        pageId: 'page1',
        changeGroupId: 'cg1',
        activityContentRef: 'beforeRef',
      });

      expect(result).toEqual({
        pageId: 'page1',
        changeGroupId: 'cg1',
        beforeContentRef: 'beforeRef',
        afterContentRef: 'afterRef',
        beforeRevision: 4,
        afterRevision: 5,
      });
    });

    it('given_noActivityContentRef_usesNullForBefore', async () => {
      setupSelectMock([{
        id: 'v1',
        pageId: 'page1',
        contentRef: 'afterRef',
        pageRevision: 3,
        changeGroupId: 'cg1',
      }]);

      const result = await resolveVersionContent({
        pageId: 'page1',
        changeGroupId: 'cg1',
      });

      expect(result?.beforeContentRef).toBeNull();
    });

    it('given_revisionZero_beforeRevisionStaysZero', async () => {
      setupSelectMock([{
        id: 'v1',
        pageId: 'page1',
        contentRef: 'ref',
        pageRevision: 0,
        changeGroupId: 'cg1',
      }]);

      const result = await resolveVersionContent({
        pageId: 'page1',
        changeGroupId: 'cg1',
      });

      expect(result?.beforeRevision).toBe(0);
      expect(result?.afterRevision).toBe(0);
    });

    it('given_databaseError_propagatesWithoutCatching', async () => {
      const mockSelect = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockRejectedValue(new Error('connection lost')),
            }),
          }),
        }),
      });
      (db.select as ReturnType<typeof vi.fn>).mockImplementation(mockSelect);

      await expect(resolveVersionContent({
        pageId: 'page1',
        changeGroupId: 'cg1',
      })).rejects.toThrow('connection lost');
    });
  });

  describe('batchResolveVersionContent', () => {
    it('given_emptyRequests_returnsEmptyMap', async () => {
      const result = await batchResolveVersionContent([]);

      expect(result.size).toBe(0);
    });

    it('given_multipleRequests_resolvesUsingCompositeKeys', async () => {
      setupBatchSelectMock([
        { id: 'v1', pageId: 'page1', contentRef: 'ref1', pageRevision: 2, changeGroupId: 'cg1' },
        { id: 'v2', pageId: 'page2', contentRef: 'ref2', pageRevision: 4, changeGroupId: 'cg2' },
      ]);

      const requests: VersionResolveRequest[] = [
        { pageId: 'page1', changeGroupId: 'cg1', activityContentRef: 'before1' },
        { pageId: 'page2', changeGroupId: 'cg2', activityContentRef: 'before2' },
      ];

      const result = await batchResolveVersionContent(requests);

      expect(result.size).toBe(2);
      expect(result.get('page1:cg1')).toEqual(expect.objectContaining({
        afterContentRef: 'ref1',
        beforeContentRef: 'before1',
      }));
      expect(result.get('page2:cg2')).toEqual(expect.objectContaining({
        afterContentRef: 'ref2',
        beforeContentRef: 'before2',
      }));
    });

    it('given_duplicateCompositeKeys_keepsHighestRevision', async () => {
      setupBatchSelectMock([
        { id: 'v1', pageId: 'page1', contentRef: 'ref-high', pageRevision: 5, changeGroupId: 'cg1' },
        { id: 'v2', pageId: 'page1', contentRef: 'ref-low', pageRevision: 3, changeGroupId: 'cg1' },
      ]);

      const result = await batchResolveVersionContent([
        { pageId: 'page1', changeGroupId: 'cg1' },
      ]);

      expect(result.size).toBe(1);
      expect(result.get('page1:cg1')?.afterContentRef).toBe('ref-high');
    });

    it('given_nullChangeGroupId_skipsVersion', async () => {
      setupBatchSelectMock([
        { id: 'v1', pageId: 'page1', contentRef: 'ref1', pageRevision: 2, changeGroupId: null },
      ]);

      const result = await batchResolveVersionContent([
        { pageId: 'page1', changeGroupId: 'cg1' },
      ]);

      expect(result.size).toBe(0);
    });

    it('given_missingVersion_excludesFromResults', async () => {
      setupBatchSelectMock([
        { id: 'v1', pageId: 'page1', contentRef: 'ref1', pageRevision: 2, changeGroupId: 'cg1' },
      ]);

      const result = await batchResolveVersionContent([
        { pageId: 'page1', changeGroupId: 'cg1' },
        { pageId: 'page2', changeGroupId: 'cg-missing' },
      ]);

      expect(result.size).toBe(1);
      expect(result.has('page1:cg1')).toBe(true);
      expect(result.has('page2:cg-missing')).toBe(false);
    });

    it('given_revisionZero_beforeRevisionStaysZero', async () => {
      setupBatchSelectMock([
        { id: 'v1', pageId: 'page1', contentRef: 'ref1', pageRevision: 0, changeGroupId: 'cg1' },
      ]);

      const result = await batchResolveVersionContent([
        { pageId: 'page1', changeGroupId: 'cg1' },
      ]);

      const pair = result.get('page1:cg1');
      expect(pair?.beforeRevision).toBe(0);
      expect(pair?.afterRevision).toBe(0);
    });

    it('given_databaseError_propagates', async () => {
      const mockSelect = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockRejectedValue(new Error('timeout')),
          }),
        }),
      });
      (db.select as ReturnType<typeof vi.fn>).mockImplementation(mockSelect);

      await expect(batchResolveVersionContent([
        { pageId: 'page1', changeGroupId: 'cg1' },
      ])).rejects.toThrow('timeout');
    });
  });

  describe('resolveStackedVersionContent', () => {
    it('given_emptyInput_returnsEmptyMap', async () => {
      const result = await resolveStackedVersionContent([]);

      expect(result.size).toBe(0);
    });

    it('given_groupedActivities_usesFirstContentRefAsBefore', async () => {
      setupBatchSelectMock([
        { id: 'v1', pageId: 'page1', contentRef: 'finalRef', pageRevision: 5, changeGroupId: 'cg1' },
      ]);

      const result = await resolveStackedVersionContent([
        { changeGroupId: 'cg1', pageId: 'page1', firstContentRef: 'initialRef' },
      ]);

      expect(result.size).toBe(1);
      const pair = result.get('page1:cg1');
      expect(pair?.beforeContentRef).toBe('initialRef');
      expect(pair?.afterContentRef).toBe('finalRef');
    });

    it('given_nullFirstContentRef_setsBeforeToNull', async () => {
      setupBatchSelectMock([
        { id: 'v1', pageId: 'page1', contentRef: 'finalRef', pageRevision: 2, changeGroupId: 'cg1' },
      ]);

      const result = await resolveStackedVersionContent([
        { changeGroupId: 'cg1', pageId: 'page1', firstContentRef: null },
      ]);

      expect(result.get('page1:cg1')?.beforeContentRef).toBeNull();
    });

    it('given_multipleGroups_resolvesAll', async () => {
      setupBatchSelectMock([
        { id: 'v1', pageId: 'page1', contentRef: 'ref1', pageRevision: 3, changeGroupId: 'cg1' },
        { id: 'v2', pageId: 'page2', contentRef: 'ref2', pageRevision: 7, changeGroupId: 'cg2' },
      ]);

      const result = await resolveStackedVersionContent([
        { changeGroupId: 'cg1', pageId: 'page1', firstContentRef: 'before1' },
        { changeGroupId: 'cg2', pageId: 'page2', firstContentRef: 'before2' },
      ]);

      expect(result.size).toBe(2);
      expect(result.get('page1:cg1')?.beforeContentRef).toBe('before1');
      expect(result.get('page2:cg2')?.beforeContentRef).toBe('before2');
    });
  });
});
