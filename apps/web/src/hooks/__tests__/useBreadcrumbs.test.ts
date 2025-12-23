/**
 * useBreadcrumbs Hook Tests
 * Tests for breadcrumb data fetching with SWR
 *
 * These tests validate observable behavior:
 * - Breadcrumb data correctly returned from hook
 * - Loading and error states exposed
 * - Null pageId handling
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

// Create hoisted mocks
const { mockSWRState, mockMutate } = vi.hoisted(() => ({
  mockSWRState: {
    data: undefined as unknown,
    error: undefined as unknown,
  },
  mockMutate: vi.fn(),
}));

// Mock fetchWithAuth
vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn(),
}));

// Mock SWR to control its behavior - simulate actual SWR isLoading behavior
vi.mock('swr', () => ({
  default: vi.fn((key) => {
    if (!key) {
      // Null key: SWR doesn't fetch, so isLoading is false (no request in flight)
      return { data: undefined, error: undefined, isLoading: false, mutate: mockMutate };
    }
    return {
      data: mockSWRState.data,
      error: mockSWRState.error,
      // SWR's isLoading is true only when there's no data AND no error (request in flight)
      isLoading: !mockSWRState.error && !mockSWRState.data,
      mutate: mockMutate,
    };
  }),
}));

import { useBreadcrumbs } from '../useBreadcrumbs';

// Helper to create mock breadcrumb items
const createMockBreadcrumb = (overrides = {}) => ({
  id: 'page-' + Math.random().toString(36).slice(2, 11),
  title: 'Test Page',
  type: 'DOCUMENT' as const,
  parentId: null,
  driveId: 'drive-123',
  drive: { id: 'drive-123', slug: 'test-drive', name: 'Test Drive' },
  ...overrides,
});

describe('useBreadcrumbs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSWRState.data = undefined;
    mockSWRState.error = undefined;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('breadcrumb data', () => {
    it('given SWR returns breadcrumb array, should expose breadcrumbs', () => {
      const mockBreadcrumbs = [
        createMockBreadcrumb({ id: 'root', title: 'Root', parentId: null }),
        createMockBreadcrumb({ id: 'parent', title: 'Parent', parentId: 'root' }),
        createMockBreadcrumb({ id: 'current', title: 'Current Page', parentId: 'parent' }),
      ];
      mockSWRState.data = mockBreadcrumbs;

      const { result } = renderHook(() => useBreadcrumbs('current'));

      // Observable: breadcrumbs exposed
      expect(result.current.breadcrumbs).toEqual(mockBreadcrumbs);
      expect(result.current.breadcrumbs).toHaveLength(3);
    });

    it('given breadcrumb has drive info, should include it', () => {
      const mockBreadcrumbs = [
        createMockBreadcrumb({
          id: 'page-1',
          drive: { id: 'drive-abc', slug: 'my-drive', name: 'My Drive' },
        }),
      ];
      mockSWRState.data = mockBreadcrumbs;

      const { result } = renderHook(() => useBreadcrumbs('page-1'));

      // Observable: drive info accessible
      expect(result.current.breadcrumbs?.[0].drive).toEqual({
        id: 'drive-abc',
        slug: 'my-drive',
        name: 'My Drive',
      });
    });

    it('given various page types in path, should include all types', () => {
      const mockBreadcrumbs = [
        createMockBreadcrumb({ id: 'folder', type: 'FOLDER', title: 'Folder' }),
        createMockBreadcrumb({ id: 'doc', type: 'DOCUMENT', title: 'Document', parentId: 'folder' }),
        createMockBreadcrumb({ id: 'chat', type: 'AI_CHAT', title: 'Chat', parentId: 'doc' }),
      ];
      mockSWRState.data = mockBreadcrumbs;

      const { result } = renderHook(() => useBreadcrumbs('chat'));

      // Observable: different page types preserved
      expect(result.current.breadcrumbs?.[0].type).toBe('FOLDER');
      expect(result.current.breadcrumbs?.[1].type).toBe('DOCUMENT');
      expect(result.current.breadcrumbs?.[2].type).toBe('AI_CHAT');
    });
  });

  describe('loading state', () => {
    it('given no data and no error, should return isLoading=true', () => {
      // isLoading is computed as !error && !data
      mockSWRState.data = undefined;
      mockSWRState.error = undefined;

      const { result } = renderHook(() => useBreadcrumbs('page-123'));

      expect(result.current.isLoading).toBe(true);
      expect(result.current.breadcrumbs).toBeUndefined();
    });

    it('given data is loaded, should return isLoading=false', () => {
      // When data exists, isLoading = !error && !data = false
      mockSWRState.data = [createMockBreadcrumb()];

      const { result } = renderHook(() => useBreadcrumbs('page-123'));

      expect(result.current.isLoading).toBe(false);
      expect(result.current.breadcrumbs).toBeDefined();
    });
  });

  describe('error state', () => {
    it('given SWR returns error, should expose isError', () => {
      const error = new Error('Failed to fetch breadcrumbs');
      mockSWRState.error = error;

      const { result } = renderHook(() => useBreadcrumbs('page-123'));

      // Observable: error exposed
      expect(result.current.isError).toBe(error);
    });

    it('given no error, should not expose isError', () => {
      mockSWRState.data = [createMockBreadcrumb()];
      mockSWRState.error = undefined;

      const { result } = renderHook(() => useBreadcrumbs('page-123'));

      expect(result.current.isError).toBeUndefined();
    });
  });

  describe('null pageId handling', () => {
    it('given null pageId, should return undefined breadcrumbs', () => {
      mockSWRState.data = [createMockBreadcrumb()]; // Data exists but shouldn't be returned

      const { result } = renderHook(() => useBreadcrumbs(null));

      // Observable: no data when no pageId
      expect(result.current.breadcrumbs).toBeUndefined();
    });

    it('given null pageId, should return isLoading=false (no fetch needed)', () => {
      const { result } = renderHook(() => useBreadcrumbs(null));

      // With null key, SWR doesn't fetch so isLoading is false
      expect(result.current.isLoading).toBe(false);
      expect(result.current.breadcrumbs).toBeUndefined();
    });
  });

  describe('empty breadcrumbs', () => {
    it('given empty array returned, should expose empty breadcrumbs', () => {
      mockSWRState.data = [];

      const { result } = renderHook(() => useBreadcrumbs('orphan-page'));

      // Observable: empty array is valid
      expect(result.current.breadcrumbs).toEqual([]);
      expect(result.current.breadcrumbs).toHaveLength(0);
    });
  });
});
