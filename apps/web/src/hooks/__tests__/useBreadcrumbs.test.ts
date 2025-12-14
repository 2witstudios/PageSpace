/**
 * useBreadcrumbs Hook Tests
 * Tests for breadcrumb data fetching with SWR
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

// Mock fetchWithAuth
const mockFetchWithAuth = vi.fn();
vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
}));

// Mock SWR to control its behavior
vi.mock('swr', () => ({
  default: vi.fn((key, fetcher) => {
    if (!key) {
      return { data: undefined, error: undefined };
    }
    // Return mock data based on the key
    const mockData = vi.mocked(mockFetchWithAuth).mock.results[0]?.value;
    return {
      data: mockData,
      error: undefined,
    };
  }),
}));

import { useBreadcrumbs } from '../useBreadcrumbs';
import useSWR from 'swr';

// Helper to create mock breadcrumb items
const createMockBreadcrumb = (overrides = {}) => ({
  id: 'page-' + Math.random().toString(36).substr(2, 9),
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
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('SWR key generation', () => {
    it('given a valid pageId, should generate correct SWR key', () => {
      vi.mocked(useSWR).mockImplementation((key) => {
        expect(key).toBe('/api/pages/page-123/breadcrumbs');
        return { data: [], error: undefined };
      });

      renderHook(() => useBreadcrumbs('page-123'));

      expect(useSWR).toHaveBeenCalledWith(
        '/api/pages/page-123/breadcrumbs',
        expect.any(Function)
      );
    });

    it('given null pageId, should pass null as SWR key', () => {
      vi.mocked(useSWR).mockImplementation((key) => {
        expect(key).toBeNull();
        return { data: undefined, error: undefined };
      });

      renderHook(() => useBreadcrumbs(null));

      expect(useSWR).toHaveBeenCalledWith(null, expect.any(Function));
    });

    it('given pageId with special characters, should pass it directly to SWR', () => {
      // Note: The hook passes pageId directly without encoding
      // URL encoding should be handled by fetchWithAuth
      vi.mocked(useSWR).mockImplementation((key) => {
        if (key === '/api/pages/page with spaces/breadcrumbs') {
          return { data: [], error: undefined };
        }
        return { data: undefined, error: undefined };
      });

      renderHook(() => useBreadcrumbs('page with spaces'));

      expect(useSWR).toHaveBeenCalledWith(
        '/api/pages/page with spaces/breadcrumbs',
        expect.any(Function)
      );
    });
  });

  describe('return values', () => {
    it('given data is loaded, should return breadcrumbs', () => {
      const mockBreadcrumbs = [
        createMockBreadcrumb({ id: 'root', title: 'Root' }),
        createMockBreadcrumb({ id: 'parent', title: 'Parent', parentId: 'root' }),
        createMockBreadcrumb({ id: 'current', title: 'Current', parentId: 'parent' }),
      ];

      vi.mocked(useSWR).mockReturnValue({
        data: mockBreadcrumbs,
        error: undefined,
        mutate: vi.fn(),
        isLoading: false,
        isValidating: false,
      });

      const { result } = renderHook(() => useBreadcrumbs('current'));

      expect(result.current.breadcrumbs).toEqual(mockBreadcrumbs);
      expect(result.current.isError).toBeUndefined();
    });

    it('given data is loading, should return isLoading=true', () => {
      vi.mocked(useSWR).mockReturnValue({
        data: undefined,
        error: undefined,
        mutate: vi.fn(),
        isLoading: true,
        isValidating: false,
      });

      const { result } = renderHook(() => useBreadcrumbs('page-123'));

      expect(result.current.isLoading).toBe(true);
      expect(result.current.breadcrumbs).toBeUndefined();
    });

    it('given error occurs, should return isError', () => {
      const error = new Error('Failed to fetch');
      vi.mocked(useSWR).mockReturnValue({
        data: undefined,
        error,
        mutate: vi.fn(),
        isLoading: false,
        isValidating: false,
      });

      const { result } = renderHook(() => useBreadcrumbs('page-123'));

      expect(result.current.isError).toBe(error);
    });

    it('given null pageId, should return loading state appropriately', () => {
      vi.mocked(useSWR).mockReturnValue({
        data: undefined,
        error: undefined,
        mutate: vi.fn(),
        isLoading: false,
        isValidating: false,
      });

      const { result } = renderHook(() => useBreadcrumbs(null));

      expect(result.current.breadcrumbs).toBeUndefined();
      // With null key, SWR won't fetch, so isLoading is computed as: !error && !data = true
      expect(result.current.isLoading).toBe(true);
    });
  });

  describe('breadcrumb data structure', () => {
    it('should support various page types in breadcrumbs', () => {
      const mockBreadcrumbs = [
        createMockBreadcrumb({ type: 'FOLDER' }),
        createMockBreadcrumb({ type: 'DOCUMENT' }),
        createMockBreadcrumb({ type: 'AI_CHAT' }),
      ];

      vi.mocked(useSWR).mockReturnValue({
        data: mockBreadcrumbs,
        error: undefined,
        mutate: vi.fn(),
        isLoading: false,
        isValidating: false,
      });

      const { result } = renderHook(() => useBreadcrumbs('page-123'));

      expect(result.current.breadcrumbs?.[0].type).toBe('FOLDER');
      expect(result.current.breadcrumbs?.[1].type).toBe('DOCUMENT');
      expect(result.current.breadcrumbs?.[2].type).toBe('AI_CHAT');
    });

    it('should include drive information in breadcrumbs', () => {
      const mockBreadcrumbs = [
        createMockBreadcrumb({
          drive: { id: 'drive-abc', slug: 'my-drive', name: 'My Drive' },
        }),
      ];

      vi.mocked(useSWR).mockReturnValue({
        data: mockBreadcrumbs,
        error: undefined,
        mutate: vi.fn(),
        isLoading: false,
        isValidating: false,
      });

      const { result } = renderHook(() => useBreadcrumbs('page-123'));

      expect(result.current.breadcrumbs?.[0].drive).toEqual({
        id: 'drive-abc',
        slug: 'my-drive',
        name: 'My Drive',
      });
    });
  });
});
