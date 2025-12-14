/**
 * usePageTree Hook Tests
 * Tests for page tree data fetching and manipulation with SWR
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Create hoisted mocks
const {
  mockFetchWithAuth,
  mockMutate,
  mockCacheDelete,
  mockSWRState,
  mockIsAnyEditing,
} = vi.hoisted(() => ({
  mockFetchWithAuth: vi.fn(),
  mockMutate: vi.fn(),
  mockCacheDelete: vi.fn(),
  mockSWRState: {
    data: undefined as unknown,
    error: undefined as unknown,
  },
  mockIsAnyEditing: vi.fn(() => false),
}));

// Mock dependencies with hoisted mocks
vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
}));

vi.mock('@/stores/useEditingStore', () => ({
  useEditingStore: {
    getState: () => ({
      isAnyEditing: mockIsAnyEditing,
    }),
  },
}));

vi.mock('@/lib/tree/tree-utils', () => ({
  mergeChildren: vi.fn((tree, pageId, children) => {
    return tree.map((page: { id: string; children?: unknown[] }) => {
      if (page.id === pageId) {
        return { ...page, children };
      }
      return page;
    });
  }),
}));

vi.mock('swr', () => ({
  default: vi.fn(() => ({
    data: mockSWRState.data,
    error: mockSWRState.error,
    mutate: mockMutate,
    isLoading: mockSWRState.data === undefined && mockSWRState.error === undefined,
  })),
  useSWRConfig: vi.fn(() => ({
    cache: {
      delete: mockCacheDelete,
    },
  })),
}));

import { usePageTree, type TreePage } from '../usePageTree';

// Helper to create mock tree page
const createMockTreePage = (overrides: Partial<TreePage> = {}): TreePage => ({
  id: 'page-' + Math.random().toString(36).substr(2, 9),
  title: 'Test Page',
  type: 'DOCUMENT',
  parentId: null,
  driveId: 'drive-123',
  position: 0,
  content: '',
  createdAt: new Date(),
  updatedAt: new Date(),
  isDeleted: false,
  deletedAt: null,
  children: [],
  aiChat: null,
  messages: [],
  ...overrides,
});

describe('usePageTree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSWRState.data = undefined;
    mockSWRState.error = undefined;
    mockIsAnyEditing.mockReturnValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('return values', () => {
    it('given data is loaded, should return tree', () => {
      const mockTree = [
        createMockTreePage({ id: 'page-1' }),
        createMockTreePage({ id: 'page-2' }),
      ];
      mockSWRState.data = mockTree;

      const { result } = renderHook(() => usePageTree('drive-123'));

      expect(result.current.tree).toEqual(mockTree);
      expect(result.current.isError).toBeUndefined();
    });

    it('given data is loading, should return empty tree and isLoading=true', () => {
      mockSWRState.data = undefined;
      mockSWRState.error = undefined;

      const { result } = renderHook(() => usePageTree('drive-123'));

      expect(result.current.tree).toEqual([]);
      expect(result.current.isLoading).toBe(true);
    });

    it('given error occurs, should return isError', () => {
      const error = new Error('Failed to fetch');
      mockSWRState.error = error;

      const { result } = renderHook(() => usePageTree('drive-123'));

      expect(result.current.isError).toBe(error);
    });
  });

  describe('updateNode', () => {
    it('given a node ID and updates, should call mutate with updated tree', () => {
      const mockTree = [
        createMockTreePage({ id: 'page-1', title: 'Old Title' }),
      ];
      mockSWRState.data = mockTree;

      const { result } = renderHook(() => usePageTree('drive-123'));

      act(() => {
        result.current.updateNode('page-1', { title: 'New Title' });
      });

      expect(mockMutate).toHaveBeenCalled();
      const updateFn = mockMutate.mock.calls[0][0];
      expect(Array.isArray(updateFn)).toBe(true);
      expect(updateFn[0].title).toBe('New Title');
    });

    it('given a nested node, should update it correctly', () => {
      const mockTree = [
        createMockTreePage({
          id: 'parent',
          children: [
            createMockTreePage({ id: 'child', title: 'Child Title' }),
          ],
        }),
      ];
      mockSWRState.data = mockTree;

      const { result } = renderHook(() => usePageTree('drive-123'));

      act(() => {
        result.current.updateNode('child', { title: 'Updated Child' });
      });

      expect(mockMutate).toHaveBeenCalled();
    });

    it('given a non-existent node, should not throw', () => {
      mockSWRState.data = [createMockTreePage({ id: 'page-1' })];

      const { result } = renderHook(() => usePageTree('drive-123'));

      expect(() => {
        act(() => {
          result.current.updateNode('non-existent', { title: 'Test' });
        });
      }).not.toThrow();
    });
  });

  describe('fetchAndMergeChildren', () => {
    it('given a page ID, should fetch children and merge', async () => {
      mockSWRState.data = [createMockTreePage({ id: 'parent', children: [] })];
      const mockChildren = [createMockTreePage({ id: 'child-1' })];
      mockFetchWithAuth.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockChildren),
      });

      const { result } = renderHook(() => usePageTree('drive-123'));

      await act(async () => {
        await result.current.fetchAndMergeChildren('parent');
      });

      expect(mockFetchWithAuth).toHaveBeenCalledWith('/api/pages/parent/children');
      expect(mockMutate).toHaveBeenCalled();
    });

    it('given API error, should log error and not throw', async () => {
      mockSWRState.data = [createMockTreePage({ id: 'parent' })];
      mockFetchWithAuth.mockRejectedValue(new Error('API error'));
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { result } = renderHook(() => usePageTree('drive-123'));

      await act(async () => {
        await result.current.fetchAndMergeChildren('parent');
      });

      expect(consoleError).toHaveBeenCalled();
      consoleError.mockRestore();
    });
  });

  describe('invalidateTree', () => {
    it('given no active editing, should delete cache and mutate', () => {
      mockSWRState.data = [createMockTreePage()];
      mockIsAnyEditing.mockReturnValue(false);

      const { result } = renderHook(() => usePageTree('drive-123'));

      act(() => {
        result.current.invalidateTree();
      });

      expect(mockCacheDelete).toHaveBeenCalledWith('/api/drives/drive-123/pages');
      expect(mockMutate).toHaveBeenCalled();
    });

    it('given active editing, should skip invalidation', () => {
      mockSWRState.data = [createMockTreePage()];
      mockIsAnyEditing.mockReturnValue(true);
      const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});

      const { result } = renderHook(() => usePageTree('drive-123'));

      act(() => {
        result.current.invalidateTree();
      });

      expect(mockCacheDelete).not.toHaveBeenCalled();
      expect(consoleLog).toHaveBeenCalledWith(
        expect.stringContaining('Skipping tree revalidation')
      );
      consoleLog.mockRestore();
    });
  });

  describe('mutate passthrough', () => {
    it('should expose SWR mutate function', () => {
      mockSWRState.data = [createMockTreePage()];

      const { result } = renderHook(() => usePageTree('drive-123'));

      expect(result.current.mutate).toBe(mockMutate);
    });
  });
});
