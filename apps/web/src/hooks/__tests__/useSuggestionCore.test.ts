import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const mockContextClose = vi.hoisted(() => vi.fn());
const mockSetItems = vi.hoisted(() => vi.fn());
const mockSetSelectedIndex = vi.hoisted(() => vi.fn());
const mockSetLoading = vi.hoisted(() => vi.fn());
const mockSetError = vi.hoisted(() => vi.fn());

const mockContext = vi.hoisted(() => ({
  isOpen: false,
  items: [] as Array<{ id: string; label: string; type: string; data: Record<string, unknown> }>,
  selectedIndex: 0,
  position: null,
  loading: false,
  error: null as string | null,
  open: vi.fn(),
  close: mockContextClose,
  setItems: mockSetItems,
  setSelectedIndex: mockSetSelectedIndex,
  setLoading: mockSetLoading,
  setError: mockSetError,
}));

vi.mock('@/components/providers/SuggestionProvider', () => ({
  useSuggestionContext: () => mockContext,
}));

const mockFetchSuggestions = vi.hoisted(() => vi.fn());

vi.mock('@/services/suggestionService', () => ({
  suggestionApi: {
    fetchSuggestions: mockFetchSuggestions,
  },
}));

import { useSuggestionCore } from '../useSuggestionCore';

describe('useSuggestionCore', () => {
  const mockOnSelect = vi.fn();
  const mockOnClose = vi.fn();
  const mockOnOpen = vi.fn();

  const defaultConfig = {
    driveId: 'drive-1',
    allowedTypes: ['page', 'user'] as ('page' | 'user')[],
    minQueryLength: 2,
    debounceMs: 50,
  };

  const defaultCallbacks = {
    onSelect: mockOnSelect,
    onClose: mockOnClose,
    onOpen: mockOnOpen,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockContext.isOpen = false;
    mockContext.items = [];
    mockContext.selectedIndex = 0;
    mockContext.loading = false;
    mockContext.error = null;

    mockFetchSuggestions.mockResolvedValue({
      suggestions: [
        { id: 'p1', label: 'Page One', type: 'page', data: { pageType: 'DOCUMENT', driveId: 'drive-1' } },
      ],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('initial state', () => {
    it('should return isOpen from context', () => {
      mockContext.isOpen = true;

      const { result } = renderHook(() =>
        useSuggestionCore(defaultConfig, defaultCallbacks)
      );

      expect(result.current.state.isOpen).toBe(true);
    });

    it('should return items from context', () => {
      const items = [
        { id: '1', label: 'Alice', type: 'user', data: {} },
      ];
      mockContext.items = items;

      const { result } = renderHook(() =>
        useSuggestionCore(defaultConfig, defaultCallbacks)
      );

      expect(result.current.state.items).toEqual(items);
    });

    it('should return selectedIndex from context', () => {
      mockContext.selectedIndex = 2;

      const { result } = renderHook(() =>
        useSuggestionCore(defaultConfig, defaultCallbacks)
      );

      expect(result.current.state.selectedIndex).toBe(2);
    });

    it('should return loading from context', () => {
      mockContext.loading = true;

      const { result } = renderHook(() =>
        useSuggestionCore(defaultConfig, defaultCallbacks)
      );

      expect(result.current.state.loading).toBe(true);
    });
  });

  describe('open', () => {
    it('should call onOpen callback when opening', () => {
      const { result } = renderHook(() =>
        useSuggestionCore(defaultConfig, defaultCallbacks)
      );

      act(() => {
        result.current.actions.open('test');
      });

      expect(mockOnOpen).toHaveBeenCalled();
    });

    it('should trigger debounced fetch when opening with query', async () => {
      const { result } = renderHook(() =>
        useSuggestionCore(defaultConfig, defaultCallbacks)
      );

      act(() => {
        result.current.actions.open('test query');
      });

      // Wait for debounce
      await act(async () => {
        vi.advanceTimersByTime(100);
      });

      expect(mockFetchSuggestions).toHaveBeenCalledWith(
        'test query',
        'drive-1',
        ['page', 'user'],
        undefined,
      );
    });
  });

  describe('close', () => {
    it('should call context.close when closing', () => {
      const { result } = renderHook(() =>
        useSuggestionCore(defaultConfig, defaultCallbacks)
      );

      act(() => {
        result.current.actions.close();
      });

      expect(mockContextClose).toHaveBeenCalled();
    });

    it('should call onClose callback when closing', () => {
      const { result } = renderHook(() =>
        useSuggestionCore(defaultConfig, defaultCallbacks)
      );

      act(() => {
        result.current.actions.close();
      });

      expect(mockOnClose).toHaveBeenCalled();
    });
  });

  describe('setQuery', () => {
    it('should debounce fetch for query', async () => {
      const { result } = renderHook(() =>
        useSuggestionCore(defaultConfig, defaultCallbacks)
      );

      act(() => {
        result.current.actions.setQuery('he');
      });

      // Before debounce fires
      expect(mockFetchSuggestions).not.toHaveBeenCalled();

      // After debounce
      await act(async () => {
        vi.advanceTimersByTime(100);
      });

      expect(mockFetchSuggestions).toHaveBeenCalledWith(
        'he',
        'drive-1',
        ['page', 'user'],
        undefined,
      );
    });

    it('should clear items when query is too short', async () => {
      const { result } = renderHook(() =>
        useSuggestionCore(defaultConfig, defaultCallbacks)
      );

      act(() => {
        result.current.actions.setQuery('h');
      });

      // After debounce
      await act(async () => {
        vi.advanceTimersByTime(100);
      });

      expect(mockSetItems).toHaveBeenCalledWith([]);
      expect(mockSetLoading).toHaveBeenCalledWith(false);
    });

    it('should cancel previous debounce when new query arrives', async () => {
      const { result } = renderHook(() =>
        useSuggestionCore(defaultConfig, defaultCallbacks)
      );

      act(() => {
        result.current.actions.setQuery('he');
      });

      // Another query before debounce fires
      act(() => {
        result.current.actions.setQuery('hel');
      });

      await act(async () => {
        vi.advanceTimersByTime(100);
      });

      // Should only have been called once with the latest query
      expect(mockFetchSuggestions).toHaveBeenCalledTimes(1);
      expect(mockFetchSuggestions).toHaveBeenCalledWith(
        'hel',
        'drive-1',
        ['page', 'user'],
        undefined,
      );
    });
  });

  describe('selectSuggestion', () => {
    it('should call onSelect callback with selected suggestion', () => {
      const { result } = renderHook(() =>
        useSuggestionCore(defaultConfig, defaultCallbacks)
      );

      const suggestion = { id: 'p1', label: 'Page One', type: 'page' as const, data: { pageType: 'DOCUMENT' as const, driveId: 'drive-1' } };

      act(() => {
        result.current.actions.selectSuggestion(suggestion);
      });

      expect(mockOnSelect).toHaveBeenCalledWith(suggestion);
    });

    it('should close after selecting suggestion', () => {
      const { result } = renderHook(() =>
        useSuggestionCore(defaultConfig, defaultCallbacks)
      );

      const suggestion = { id: 'p1', label: 'Page One', type: 'page' as const, data: { pageType: 'DOCUMENT' as const, driveId: 'drive-1' } };

      act(() => {
        result.current.actions.selectSuggestion(suggestion);
      });

      expect(mockContextClose).toHaveBeenCalled();
    });
  });

  describe('selectItem', () => {
    it('should update selectedIndex in context', () => {
      mockContext.items = [
        { id: '1', label: 'Alice', type: 'user', data: {} },
        { id: '2', label: 'Bob', type: 'user', data: {} },
      ];

      const { result } = renderHook(() =>
        useSuggestionCore(defaultConfig, defaultCallbacks)
      );

      act(() => {
        result.current.actions.selectItem(1);
      });

      expect(mockSetSelectedIndex).toHaveBeenCalledWith(1);
    });

    it('should not update selectedIndex when index is out of bounds', () => {
      mockContext.items = [
        { id: '1', label: 'Alice', type: 'user', data: {} },
      ];

      const { result } = renderHook(() =>
        useSuggestionCore(defaultConfig, defaultCallbacks)
      );

      act(() => {
        result.current.actions.selectItem(5);
      });

      expect(mockSetSelectedIndex).not.toHaveBeenCalled();
    });

    it('should not update selectedIndex when index is negative', () => {
      mockContext.items = [
        { id: '1', label: 'Alice', type: 'user', data: {} },
      ];

      const { result } = renderHook(() =>
        useSuggestionCore(defaultConfig, defaultCallbacks)
      );

      act(() => {
        result.current.actions.selectItem(-1);
      });

      expect(mockSetSelectedIndex).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should set error when fetch fails', async () => {
      mockFetchSuggestions.mockRejectedValue(new Error('Network error'));

      const { result } = renderHook(() =>
        useSuggestionCore(defaultConfig, defaultCallbacks)
      );

      act(() => {
        result.current.actions.setQuery('test');
      });

      await act(async () => {
        vi.advanceTimersByTime(100);
      });

      // Wait for the promise to settle
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(mockSetError).toHaveBeenCalledWith('Failed to fetch suggestions');
    });

    it('should clear items and set error when no driveId for within-drive search', async () => {
      const configWithoutDrive = {
        ...defaultConfig,
        driveId: null,
        crossDrive: false,
      };

      const { result } = renderHook(() =>
        useSuggestionCore(configWithoutDrive, defaultCallbacks)
      );

      act(() => {
        result.current.actions.setQuery('test');
      });

      await act(async () => {
        vi.advanceTimersByTime(100);
      });

      expect(mockSetItems).toHaveBeenCalledWith([]);
      expect(mockSetError).toHaveBeenCalledWith('Drive ID is required for within-drive search');
    });
  });

  describe('fetch results handling', () => {
    it('should set items and reset selectedIndex on successful fetch', async () => {
      const suggestions = [
        { id: 'p1', label: 'Page One', type: 'page', data: { pageType: 'DOCUMENT', driveId: 'drive-1' } },
        { id: 'p2', label: 'Page Two', type: 'page', data: { pageType: 'FOLDER', driveId: 'drive-1' } },
      ];

      mockFetchSuggestions.mockResolvedValue({ suggestions });

      const { result } = renderHook(() =>
        useSuggestionCore(defaultConfig, defaultCallbacks)
      );

      act(() => {
        result.current.actions.setQuery('page');
      });

      await act(async () => {
        vi.advanceTimersByTime(100);
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(mockSetItems).toHaveBeenCalledWith(suggestions);
      expect(mockSetSelectedIndex).toHaveBeenCalledWith(0);
      expect(mockSetLoading).toHaveBeenCalledWith(false);
    });
  });
});
