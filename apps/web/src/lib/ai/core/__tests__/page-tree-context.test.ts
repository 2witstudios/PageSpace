import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => {
  const mockGetUserDriveAccess = vi.fn();
  const mockPageTreeCache = {
    getDriveTree: vi.fn(),
    setDriveTree: vi.fn(),
  };
  const mockLoggers = {
    ai: {
      debug: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    },
  };
  const mockBuildTree = vi.fn();
  const mockFormatTreeAsMarkdown = vi.fn();
  const mockFilterToSubtree = vi.fn();
  return {
    mockGetUserDriveAccess,
    mockPageTreeCache,
    mockLoggers,
    mockBuildTree,
    mockFormatTreeAsMarkdown,
    mockFilterToSubtree,
  };
});

vi.mock('@pagespace/db', () => ({
  db: {
    select: vi.fn(),
  },
  pages: {
    id: 'id',
    title: 'title',
    type: 'type',
    parentId: 'parentId',
    position: 'position',
    driveId: 'driveId',
    isTrashed: 'isTrashed',
  },
  drives: {
    id: 'id',
    name: 'name',
    isTrashed: 'isTrashed',
  },
  eq: vi.fn((a, b) => ({ eq: true, a, b })),
  and: vi.fn((...args) => ({ and: true, args })),
  asc: vi.fn((col) => ({ asc: true, col })),
}));

vi.mock('@pagespace/lib/server', () => ({
  getUserDriveAccess: mocks.mockGetUserDriveAccess,
  pageTreeCache: mocks.mockPageTreeCache,
  loggers: mocks.mockLoggers,
}));

vi.mock('@pagespace/lib', () => ({
  buildTree: mocks.mockBuildTree,
  formatTreeAsMarkdown: mocks.mockFormatTreeAsMarkdown,
  filterToSubtree: mocks.mockFilterToSubtree,
}));

import { getPageTreeContext, getDriveListSummary } from '../page-tree-context';
import { db } from '@pagespace/db';

describe('page-tree-context', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getPageTreeContext', () => {
    it('should return empty string when user has no drive access', async () => {
      mocks.mockGetUserDriveAccess.mockResolvedValue(false);

      const result = await getPageTreeContext('user-1', {
        scope: 'drive',
        driveId: 'drive-1',
      });

      expect(result).toBe('');
    });

    it('should return formatted tree from cache when available', async () => {
      mocks.mockGetUserDriveAccess.mockResolvedValue(true);

      const cachedNodes = [
        { id: 'page-1', title: 'Page 1', type: 'DOCUMENT', parentId: null, position: 0 },
      ];
      mocks.mockPageTreeCache.getDriveTree.mockResolvedValue({ nodes: cachedNodes });

      mocks.mockBuildTree.mockReturnValue([{ id: 'page-1', title: 'Page 1', children: [] }]);
      mocks.mockFormatTreeAsMarkdown.mockReturnValue('- Page 1');

      const result = await getPageTreeContext('user-1', {
        scope: 'drive',
        driveId: 'drive-1',
      });

      expect(result).toBe('- Page 1');
      expect(mocks.mockBuildTree).toHaveBeenCalledWith(cachedNodes);
    });

    it('should query DB and cache result on cache miss', async () => {
      mocks.mockGetUserDriveAccess.mockResolvedValue(true);
      mocks.mockPageTreeCache.getDriveTree.mockResolvedValue(null);

      const nodes = [
        { id: 'page-1', title: 'Page 1', type: 'DOCUMENT', parentId: null, position: 0 },
      ];

      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockResolvedValue(nodes),
            }),
          }),
        } as never)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ name: 'My Drive' }]),
            }),
          }),
        } as never);

      mocks.mockPageTreeCache.setDriveTree.mockResolvedValue(undefined);
      mocks.mockBuildTree.mockReturnValue([{ id: 'page-1', title: 'Page 1', children: [] }]);
      mocks.mockFormatTreeAsMarkdown.mockReturnValue('- Page 1');

      const result = await getPageTreeContext('user-1', {
        scope: 'drive',
        driveId: 'drive-1',
      });

      expect(result).toBe('- Page 1');
      expect(mocks.mockPageTreeCache.setDriveTree).toHaveBeenCalled();
    });

    it('should return empty string when nodes are empty', async () => {
      mocks.mockGetUserDriveAccess.mockResolvedValue(true);
      mocks.mockPageTreeCache.getDriveTree.mockResolvedValue({ nodes: [] });

      const result = await getPageTreeContext('user-1', {
        scope: 'drive',
        driveId: 'drive-1',
      });

      expect(result).toBe('');
      expect(mocks.mockBuildTree).not.toHaveBeenCalled();
    });

    it('should filter to subtree when scope is children', async () => {
      mocks.mockGetUserDriveAccess.mockResolvedValue(true);

      const allNodes = [
        { id: 'page-1', title: 'Parent', type: 'FOLDER', parentId: null, position: 0 },
        { id: 'page-2', title: 'Child', type: 'DOCUMENT', parentId: 'page-1', position: 0 },
        { id: 'page-3', title: 'Other', type: 'DOCUMENT', parentId: null, position: 1 },
      ];
      const subtreeNodes = [allNodes[0], allNodes[1]];

      mocks.mockPageTreeCache.getDriveTree.mockResolvedValue({ nodes: allNodes });
      mocks.mockFilterToSubtree.mockReturnValue(subtreeNodes);
      mocks.mockBuildTree.mockReturnValue([]);
      mocks.mockFormatTreeAsMarkdown.mockReturnValue('- Parent\n  - Child');

      await getPageTreeContext('user-1', {
        scope: 'children',
        pageId: 'page-1',
        driveId: 'drive-1',
      });

      expect(mocks.mockFilterToSubtree).toHaveBeenCalledWith(allNodes, 'page-1');
    });

    it('should use maxNodes option when provided', async () => {
      mocks.mockGetUserDriveAccess.mockResolvedValue(true);

      const nodes = [{ id: 'page-1', title: 'Page 1', type: 'DOCUMENT', parentId: null, position: 0 }];
      mocks.mockPageTreeCache.getDriveTree.mockResolvedValue({ nodes });
      mocks.mockBuildTree.mockReturnValue([]);
      mocks.mockFormatTreeAsMarkdown.mockReturnValue('- Page 1');

      await getPageTreeContext('user-1', {
        scope: 'drive',
        driveId: 'drive-1',
        maxNodes: 50,
      });

      expect(mocks.mockFormatTreeAsMarkdown).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ maxNodes: 50 })
      );
    });

    it('should use default maxNodes of 200', async () => {
      mocks.mockGetUserDriveAccess.mockResolvedValue(true);

      const nodes = [{ id: 'page-1', title: 'Page', type: 'DOCUMENT', parentId: null, position: 0 }];
      mocks.mockPageTreeCache.getDriveTree.mockResolvedValue({ nodes });
      mocks.mockBuildTree.mockReturnValue([]);
      mocks.mockFormatTreeAsMarkdown.mockReturnValue('- Page');

      await getPageTreeContext('user-1', {
        scope: 'drive',
        driveId: 'drive-1',
      });

      expect(mocks.mockFormatTreeAsMarkdown).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ maxNodes: 200 })
      );
    });

    it('should return empty string on error', async () => {
      mocks.mockGetUserDriveAccess.mockRejectedValue(new Error('Access check failed'));

      const result = await getPageTreeContext('user-1', {
        scope: 'drive',
        driveId: 'drive-1',
      });

      expect(result).toBe('');
      expect(mocks.mockLoggers.ai.error).toHaveBeenCalled();
    });
  });

  describe('getDriveListSummary', () => {
    it('should return list of accessible drives', async () => {
      const drives = [
        { id: 'drive-1', name: 'Personal' },
        { id: 'drive-2', name: 'Work' },
      ];

      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(drives),
        }),
      } as never);

      mocks.mockGetUserDriveAccess.mockResolvedValue(true);

      const result = await getDriveListSummary('user-1');
      expect(result).toContain('Personal');
      expect(result).toContain('Work');
      expect(result).toContain('drive-1');
      expect(result).toContain('drive-2');
    });

    it('should filter out drives user has no access to', async () => {
      const drives = [
        { id: 'drive-1', name: 'Accessible' },
        { id: 'drive-2', name: 'Restricted' },
      ];

      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(drives),
        }),
      } as never);

      mocks.mockGetUserDriveAccess.mockImplementation(async (_userId: string, driveId: string) => {
        return driveId === 'drive-1';
      });

      const result = await getDriveListSummary('user-1');
      expect(result).toContain('Accessible');
      expect(result).not.toContain('Restricted');
    });

    it('should return "No accessible workspaces." when no accessible drives', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ id: 'drive-1', name: 'Drive' }]),
        }),
      } as never);

      mocks.mockGetUserDriveAccess.mockResolvedValue(false);

      const result = await getDriveListSummary('user-1');
      expect(result).toBe('No accessible workspaces.');
    });

    it('should return "No accessible workspaces." when no drives exist', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      } as never);

      const result = await getDriveListSummary('user-1');
      expect(result).toBe('No accessible workspaces.');
    });

    it('should return empty string on error', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockRejectedValue(new Error('DB error')),
        }),
      } as never);

      const result = await getDriveListSummary('user-1');
      expect(result).toBe('');
      expect(mocks.mockLoggers.ai.error).toHaveBeenCalled();
    });
  });
});
