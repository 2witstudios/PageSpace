import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the database module
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
  eq: vi.fn((a, b) => ({ type: 'eq', field: a, value: b })),
  and: vi.fn((...args) => ({ type: 'and', conditions: args })),
  or: vi.fn((...args) => ({ type: 'or', conditions: args })),
  desc: vi.fn((field) => ({ type: 'desc', field })),
}));

import {
  resolveVersionContent,
  batchResolveVersionContent,
  resolveStackedVersionContent,
  type VersionResolveRequest,
} from '../version-resolver';
import { db } from '@pagespace/db';

describe('version-resolver (colocated)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Helper to set up db.select mock chain
  function setupSelectMock(returnValue: unknown[]) {
    const mockSelect = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(returnValue),
          }),
        }),
      }),
    });
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(mockSelect);
  }

  function setupBatchSelectMock(returnValue: unknown[]) {
    const mockSelect = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockResolvedValue(returnValue),
        }),
      }),
    });
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(mockSelect);
  }

  describe('resolveVersionContent', () => {
    it('returns null when no version found', async () => {
      setupSelectMock([]);

      const result = await resolveVersionContent({
        pageId: 'page1',
        changeGroupId: 'cg1',
      });

      expect(result).toBeNull();
    });

    it('returns version content pair when found', async () => {
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

      expect(result).not.toBeNull();
      expect(result?.pageId).toBe('page1');
      expect(result?.changeGroupId).toBe('cg1');
      expect(result?.beforeContentRef).toBe('beforeRef');
      expect(result?.afterContentRef).toBe('afterRef');
      expect(result?.beforeRevision).toBe(4);
      expect(result?.afterRevision).toBe(5);
    });

    it('uses null for beforeContentRef when activityContentRef is absent', async () => {
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

    it('handles pageRevision 0 edge case (beforeRevision stays 0)', async () => {
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
  });

  describe('batchResolveVersionContent', () => {
    it('returns empty map for empty requests array', async () => {
      const result = await batchResolveVersionContent([]);
      expect(result.size).toBe(0);
    });

    it('resolves multiple versions using composite keys', async () => {
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
      expect(result.get('page1:cg1')?.afterContentRef).toBe('ref1');
      expect(result.get('page2:cg2')?.afterContentRef).toBe('ref2');
    });

    it('deduplicates by composite key, keeping highest revision', async () => {
      setupBatchSelectMock([
        { id: 'v1', pageId: 'page1', contentRef: 'ref-high', pageRevision: 5, changeGroupId: 'cg1' },
        { id: 'v2', pageId: 'page1', contentRef: 'ref-low', pageRevision: 3, changeGroupId: 'cg1' },
      ]);

      const requests: VersionResolveRequest[] = [
        { pageId: 'page1', changeGroupId: 'cg1' },
      ];

      const result = await batchResolveVersionContent(requests);

      expect(result.size).toBe(1);
      expect(result.get('page1:cg1')?.afterContentRef).toBe('ref-high');
    });

    it('skips versions with null changeGroupId', async () => {
      setupBatchSelectMock([
        { id: 'v1', pageId: 'page1', contentRef: 'ref1', pageRevision: 2, changeGroupId: null },
      ]);

      const requests: VersionResolveRequest[] = [
        { pageId: 'page1', changeGroupId: 'cg1' },
      ];

      const result = await batchResolveVersionContent(requests);

      expect(result.size).toBe(0);
    });

    it('skips requests whose version is not found', async () => {
      setupBatchSelectMock([
        { id: 'v1', pageId: 'page1', contentRef: 'ref1', pageRevision: 2, changeGroupId: 'cg1' },
      ]);

      const requests: VersionResolveRequest[] = [
        { pageId: 'page1', changeGroupId: 'cg1' },
        { pageId: 'page2', changeGroupId: 'cg-missing' },
      ];

      const result = await batchResolveVersionContent(requests);

      expect(result.size).toBe(1);
      expect(result.has('page1:cg1')).toBe(true);
      expect(result.has('page2:cg-missing')).toBe(false);
    });

    it('handles revision 0 edge case in batch', async () => {
      setupBatchSelectMock([
        { id: 'v1', pageId: 'page1', contentRef: 'ref1', pageRevision: 0, changeGroupId: 'cg1' },
      ]);

      const requests: VersionResolveRequest[] = [
        { pageId: 'page1', changeGroupId: 'cg1' },
      ];

      const result = await batchResolveVersionContent(requests);

      const pair = result.get('page1:cg1');
      expect(pair?.beforeRevision).toBe(0);
      expect(pair?.afterRevision).toBe(0);
    });
  });

  describe('resolveStackedVersionContent', () => {
    it('returns empty map for empty input', async () => {
      const result = await resolveStackedVersionContent([]);
      expect(result.size).toBe(0);
    });

    it('delegates to batchResolveVersionContent with first content ref', async () => {
      setupBatchSelectMock([
        { id: 'v1', pageId: 'page1', contentRef: 'finalRef', pageRevision: 5, changeGroupId: 'cg1' },
      ]);

      const result = await resolveStackedVersionContent([
        {
          changeGroupId: 'cg1',
          pageId: 'page1',
          firstContentRef: 'initialRef',
        },
      ]);

      expect(result.size).toBe(1);
      const pair = result.get('page1:cg1');
      expect(pair?.beforeContentRef).toBe('initialRef');
      expect(pair?.afterContentRef).toBe('finalRef');
    });

    it('handles null firstContentRef', async () => {
      setupBatchSelectMock([
        { id: 'v1', pageId: 'page1', contentRef: 'finalRef', pageRevision: 2, changeGroupId: 'cg1' },
      ]);

      const result = await resolveStackedVersionContent([
        {
          changeGroupId: 'cg1',
          pageId: 'page1',
          firstContentRef: null,
        },
      ]);

      const pair = result.get('page1:cg1');
      expect(pair?.beforeContentRef).toBeNull();
    });

    it('resolves multiple grouped activities', async () => {
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
