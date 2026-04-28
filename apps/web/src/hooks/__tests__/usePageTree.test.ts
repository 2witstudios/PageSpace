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
  mockIsAnyActive,
} = vi.hoisted(() => ({
  mockFetchWithAuth: vi.fn(),
  mockMutate: vi.fn(),
  mockCacheDelete: vi.fn(),
  mockSWRState: {
    data: undefined as unknown,
    error: undefined as unknown,
  },
  mockIsAnyEditing: vi.fn(() => false),
  mockIsAnyActive: vi.fn(() => false),
}));

// Mock dependencies with hoisted mocks
vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
}));

vi.mock('@/stores/useEditingStore', () => ({
  useEditingStore: {
    getState: () => ({
      isAnyEditing: mockIsAnyEditing,
      isAnyActive: mockIsAnyActive,
    }),
  },
  isEditingActive: () => mockIsAnyActive(),
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
    isValidating: false,
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
  id: 'page-' + Math.random().toString(36).slice(2, 11),
  title: 'Test Page',
  type: 'DOCUMENT' as import('@pagespace/lib/utils/enums').PageType,
  parentId: null,
  originalParentId: null,
  driveId: 'drive-123',
  position: 0,
  content: '',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  isTrashed: false,
  trashedAt: null,
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
    mockIsAnyActive.mockReturnValue(false);
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
    it('given a node ID and updates, should optimistically update tree without refetch', () => {
      const mockTree = [
        createMockTreePage({ id: 'page-1', title: 'Old Title' }),
      ];
      mockSWRState.data = mockTree;

      const { result } = renderHook(() => usePageTree('drive-123'));

      act(() => {
        result.current.updateNode('page-1', { title: 'New Title' });
      });

      /** @boundary-contract Optimistic update: mutate with functional updater and revalidate=false */
      expect(mockMutate).toHaveBeenCalledTimes(1);
      expect(typeof mockMutate.mock.calls[0][0]).toBe('function');
      expect(mockMutate.mock.calls[0][1]).toEqual({ revalidate: false });

      // Observable: verify the updater function produces correct tree
      const updaterFn = mockMutate.mock.calls[0][0];
      const updatedTree = updaterFn(mockTree);
      expect(Array.isArray(updatedTree)).toBe(true);
      expect(updatedTree[0].title).toBe('New Title');
    });

    it('given a nested node, should optimistically update nested tree', () => {
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

      /** @boundary-contract Optimistic update: no refetch for nested updates */
      expect(mockMutate).toHaveBeenCalledTimes(1);
      expect(typeof mockMutate.mock.calls[0][0]).toBe('function');
      expect(mockMutate.mock.calls[0][1]).toEqual({ revalidate: false });

      // Observable: verify the updater function produces correct nested tree
      const updaterFn = mockMutate.mock.calls[0][0];
      const updatedTree = updaterFn(mockTree);
      expect(updatedTree[0].children[0].title).toBe('Updated Child');
    });

    it('given a non-existent node, should not throw and return unchanged data', () => {
      const mockTree = [createMockTreePage({ id: 'page-1' })];
      mockSWRState.data = mockTree;

      const { result } = renderHook(() => usePageTree('drive-123'));

      expect(() => {
        act(() => {
          result.current.updateNode('non-existent', { title: 'Test' });
        });
      }).not.toThrow();

      // mutate is called with functional updater, but the function returns unchanged data
      expect(mockMutate).toHaveBeenCalledTimes(1);
      expect(typeof mockMutate.mock.calls[0][0]).toBe('function');
      expect(mockMutate.mock.calls[0][1]).toEqual({ revalidate: false });
      const updaterFn = mockMutate.mock.calls[0][0];
      const updatedTree = updaterFn(mockTree);
      expect(updatedTree).toBe(mockTree); // Same reference, unchanged
    });

    it('given no data loaded yet, should no-op without mutating cache', () => {
      mockSWRState.data = undefined;

      const { result } = renderHook(() => usePageTree('drive-123'));

      expect(() => {
        act(() => {
          result.current.updateNode('page-1', { title: 'Test' });
        });
      }).not.toThrow();

      // No data means no optimistic mutation attempt.
      expect(mockMutate).not.toHaveBeenCalled();
    });

    it('given tree data changes, should keep updateNode callback stable', () => {
      mockSWRState.data = [createMockTreePage({ id: 'page-1' })];
      const { result, rerender } = renderHook(() => usePageTree('drive-123'));
      const firstUpdateNode = result.current.updateNode;

      mockSWRState.data = [createMockTreePage({ id: 'page-2' })];
      rerender();

      expect(result.current.updateNode).toBe(firstUpdateNode);
    });
  });

  describe('fetchAndMergeChildren', () => {
    it('given a page ID, should fetch children and merge optimistically', async () => {
      mockSWRState.data = [createMockTreePage({ id: 'parent', children: [] })];
      const mockChildren = [createMockTreePage({ id: 'child-1', title: 'Child 1' })];
      mockFetchWithAuth.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockChildren),
      });

      const { result } = renderHook(() => usePageTree('drive-123'));

      await act(async () => {
        await result.current.fetchAndMergeChildren('parent');
      });

      // Observable: API was called to fetch children (with AbortController signal for timeout)
      expect(mockFetchWithAuth).toHaveBeenCalledTimes(1);
      expect(mockFetchWithAuth.mock.calls[0][0]).toBe('/api/pages/parent/children');
      expect(mockFetchWithAuth.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);

      /** @boundary-contract Optimistic merge: update tree without refetch */
      expect(mockMutate).toHaveBeenCalledTimes(1);
      expect(typeof mockMutate.mock.calls[0][0]).toBe('function');
      expect(mockMutate.mock.calls[0][1]).toEqual({ revalidate: false });

      // Observable: verify updater merges children using current cache data
      const updaterFn = mockMutate.mock.calls[0][0];
      const updatedTree = updaterFn(mockSWRState.data);
      expect(updatedTree[0].children).toHaveLength(1);
      expect(updatedTree[0].children[0].id).toBe('child-1');
    });

    it('given API error, should log error and not throw', async () => {
      mockSWRState.data = [createMockTreePage({ id: 'parent' })];
      mockFetchWithAuth.mockRejectedValue(new Error('API error'));
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => { });

      const { result } = renderHook(() => usePageTree('drive-123'));

      await act(async () => {
        await result.current.fetchAndMergeChildren('parent');
      });

      // Observable: error logged but no throw
      expect(consoleError).toHaveBeenCalled();
      consoleError.mockRestore();
    });
  });

  describe('invalidateTree', () => {
    it('given no active state, should mutate without deleting cache', () => {
      mockSWRState.data = [createMockTreePage()];
      mockIsAnyActive.mockReturnValue(false);

      const { result } = renderHook(() => usePageTree('drive-123'));

      act(() => {
        result.current.invalidateTree();
      });

      expect(mockCacheDelete).not.toHaveBeenCalled();
      expect(mockMutate).toHaveBeenCalled();
    });

    it('given active document editing, should skip invalidation', () => {
      mockSWRState.data = [createMockTreePage()];
      mockIsAnyActive.mockReturnValue(true);
      const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => { });

      const { result } = renderHook(() => usePageTree('drive-123'));

      act(() => {
        result.current.invalidateTree();
      });

      expect(mockMutate).not.toHaveBeenCalled();
      expect(mockCacheDelete).not.toHaveBeenCalled();
      expect(consoleLog).toHaveBeenCalledWith(
        '⏸️ Skipping tree revalidation - document editing, AI streaming, or pending send in progress'
      );
      consoleLog.mockRestore();
    });

    it('given any active state (AI streaming or pending send), should skip invalidation', () => {
      mockSWRState.data = [createMockTreePage()];
      mockIsAnyActive.mockReturnValue(true);
      const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => { });

      const { result } = renderHook(() => usePageTree('drive-123'));

      act(() => {
        result.current.invalidateTree();
      });

      expect(mockMutate).not.toHaveBeenCalled();
      expect(mockCacheDelete).not.toHaveBeenCalled();
      consoleLog.mockRestore();
    });
  });

  describe('retry', () => {
    it('given a driveId, should delete cache and mutate without editing guard', () => {
      mockSWRState.data = [createMockTreePage()];
      mockIsAnyEditing.mockReturnValue(true);

      const { result } = renderHook(() => usePageTree('drive-123'));

      act(() => {
        result.current.retry();
      });

      // retry bypasses editing guard (unlike invalidateTree)
      expect(mockCacheDelete).toHaveBeenCalledWith('/api/drives/drive-123/pages');
      expect(mockMutate).toHaveBeenCalled();
    });

    it('given no driveId, should not attempt cache delete or mutate', () => {
      const { result } = renderHook(() => usePageTree(undefined));

      act(() => {
        result.current.retry();
      });

      expect(mockCacheDelete).not.toHaveBeenCalled();
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
