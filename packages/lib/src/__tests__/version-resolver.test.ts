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
  inArray: vi.fn((field, values) => ({ type: 'inArray', field, values })),
  desc: vi.fn((field) => ({ type: 'desc', field })),
}));

import {
  resolveVersionContent,
  batchResolveVersionContent,
  resolveStackedVersionContent,
  type VersionResolveRequest,
} from '../content/version-resolver';
import { db } from '@pagespace/db';

describe('version-resolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('resolveVersionContent', () => {
    it('returns null when no version found', async () => {
      // Mock: no version found
      const mockSelect = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      });
      (db.select as ReturnType<typeof vi.fn>).mockImplementation(mockSelect);

      const result = await resolveVersionContent({
        pageId: 'page1',
        changeGroupId: 'cg1',
      });

      expect(result).toBeNull();
    });

    it('returns version content pair when found', async () => {
      // Mock: version found
      const mockVersion = {
        id: 'version1',
        pageId: 'page1',
        contentRef: 'afterRef123',
        pageRevision: 5,
        changeGroupId: 'cg1',
      };

      const mockSelect = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([mockVersion]),
            }),
          }),
        }),
      });
      (db.select as ReturnType<typeof vi.fn>).mockImplementation(mockSelect);

      const result = await resolveVersionContent({
        pageId: 'page1',
        changeGroupId: 'cg1',
        activityContentRef: 'beforeRef456',
      });

      expect(result).not.toBeNull();
      expect(result?.pageId).toBe('page1');
      expect(result?.changeGroupId).toBe('cg1');
      expect(result?.beforeContentRef).toBe('beforeRef456');
      expect(result?.afterContentRef).toBe('afterRef123');
      expect(result?.beforeRevision).toBe(4); // pageRevision - 1
      expect(result?.afterRevision).toBe(5);
    });

    it('handles missing activity content ref', async () => {
      const mockVersion = {
        id: 'version1',
        pageId: 'page1',
        contentRef: 'afterRef123',
        pageRevision: 1,
        changeGroupId: 'cg1',
      };

      const mockSelect = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([mockVersion]),
            }),
          }),
        }),
      });
      (db.select as ReturnType<typeof vi.fn>).mockImplementation(mockSelect);

      const result = await resolveVersionContent({
        pageId: 'page1',
        changeGroupId: 'cg1',
        // No activityContentRef
      });

      expect(result).not.toBeNull();
      expect(result?.beforeContentRef).toBeNull();
      expect(result?.afterContentRef).toBe('afterRef123');
    });

    it('handles revision 0 edge case', async () => {
      const mockVersion = {
        id: 'version1',
        pageId: 'page1',
        contentRef: 'afterRef123',
        pageRevision: 0,
        changeGroupId: 'cg1',
      };

      const mockSelect = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([mockVersion]),
            }),
          }),
        }),
      });
      (db.select as ReturnType<typeof vi.fn>).mockImplementation(mockSelect);

      const result = await resolveVersionContent({
        pageId: 'page1',
        changeGroupId: 'cg1',
      });

      expect(result).not.toBeNull();
      expect(result?.beforeRevision).toBe(0); // Can't go negative
      expect(result?.afterRevision).toBe(0);
    });
  });

  describe('batchResolveVersionContent', () => {
    it('returns empty map for empty input', async () => {
      const result = await batchResolveVersionContent([]);
      expect(result.size).toBe(0);
    });

    it('resolves multiple versions in a single query', async () => {
      const mockVersions = [
        {
          id: 'v1',
          pageId: 'page1',
          contentRef: 'afterRef1',
          pageRevision: 3,
          changeGroupId: 'cg1',
        },
        {
          id: 'v2',
          pageId: 'page2',
          contentRef: 'afterRef2',
          pageRevision: 7,
          changeGroupId: 'cg2',
        },
      ];

      const mockSelect = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue(mockVersions),
          }),
        }),
      });
      (db.select as ReturnType<typeof vi.fn>).mockImplementation(mockSelect);

      const requests: VersionResolveRequest[] = [
        { pageId: 'page1', changeGroupId: 'cg1', activityContentRef: 'beforeRef1' },
        { pageId: 'page2', changeGroupId: 'cg2', activityContentRef: 'beforeRef2' },
      ];

      const result = await batchResolveVersionContent(requests);

      expect(result.size).toBe(2);
      expect(result.get('cg1')?.beforeContentRef).toBe('beforeRef1');
      expect(result.get('cg1')?.afterContentRef).toBe('afterRef1');
      expect(result.get('cg2')?.beforeContentRef).toBe('beforeRef2');
      expect(result.get('cg2')?.afterContentRef).toBe('afterRef2');
    });

    it('handles some versions not found', async () => {
      // Only one version found
      const mockVersions = [
        {
          id: 'v1',
          pageId: 'page1',
          contentRef: 'afterRef1',
          pageRevision: 3,
          changeGroupId: 'cg1',
        },
      ];

      const mockSelect = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue(mockVersions),
          }),
        }),
      });
      (db.select as ReturnType<typeof vi.fn>).mockImplementation(mockSelect);

      const requests: VersionResolveRequest[] = [
        { pageId: 'page1', changeGroupId: 'cg1' },
        { pageId: 'page2', changeGroupId: 'cg2' }, // This one won't be found
      ];

      const result = await batchResolveVersionContent(requests);

      expect(result.size).toBe(1);
      expect(result.has('cg1')).toBe(true);
      expect(result.has('cg2')).toBe(false);
    });

    it('deduplicates changeGroupIds in query', async () => {
      const mockVersions = [
        {
          id: 'v1',
          pageId: 'page1',
          contentRef: 'afterRef1',
          pageRevision: 3,
          changeGroupId: 'cg1',
        },
      ];

      const mockSelect = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue(mockVersions),
          }),
        }),
      });
      (db.select as ReturnType<typeof vi.fn>).mockImplementation(mockSelect);

      // Same changeGroupId twice
      const requests: VersionResolveRequest[] = [
        { pageId: 'page1', changeGroupId: 'cg1', activityContentRef: 'beforeRef1' },
        { pageId: 'page1', changeGroupId: 'cg1', activityContentRef: 'beforeRef1' },
      ];

      const result = await batchResolveVersionContent(requests);

      // Should still only have one result
      expect(result.size).toBe(1);
    });
  });

  describe('resolveStackedVersionContent', () => {
    it('returns empty map for empty input', async () => {
      const result = await resolveStackedVersionContent([]);
      expect(result.size).toBe(0);
    });

    it('resolves stacked activities with first content ref as before', async () => {
      const mockVersions = [
        {
          id: 'v1',
          pageId: 'page1',
          contentRef: 'finalContentRef',
          pageRevision: 5,
          changeGroupId: 'cg1',
        },
      ];

      const mockSelect = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue(mockVersions),
          }),
        }),
      });
      (db.select as ReturnType<typeof vi.fn>).mockImplementation(mockSelect);

      const result = await resolveStackedVersionContent([
        {
          changeGroupId: 'cg1',
          pageId: 'page1',
          firstContentRef: 'initialContentRef',
        },
      ]);

      expect(result.size).toBe(1);
      const pair = result.get('cg1');
      expect(pair?.beforeContentRef).toBe('initialContentRef');
      expect(pair?.afterContentRef).toBe('finalContentRef');
    });
  });
});
