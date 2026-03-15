import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const mockClose = vi.hoisted(() => vi.fn());
const mockOpen = vi.hoisted(() => vi.fn());
const mockSelectItem = vi.hoisted(() => vi.fn());
const mockSelectSuggestion = vi.hoisted(() => vi.fn());
const mockSetQuery = vi.hoisted(() => vi.fn());

const mockContextState = vi.hoisted(() => ({
  isOpen: false,
  items: [] as Array<{ id: string; label: string; type: string; data: Record<string, unknown> }>,
  selectedIndex: 0,
  position: null,
  loading: false,
  error: null as string | null,
  open: mockOpen,
  close: mockClose,
  setItems: vi.fn(),
  setSelectedIndex: vi.fn(),
  setLoading: vi.fn(),
  setError: vi.fn(),
}));

vi.mock('@/hooks/useSuggestionCore', () => ({
  useSuggestionCore: vi.fn(() => ({
    state: {
      isOpen: mockContextState.isOpen,
      items: mockContextState.items,
      selectedIndex: mockContextState.selectedIndex,
      query: '',
      loading: mockContextState.loading,
      error: null,
    },
    actions: {
      open: vi.fn(),
      close: mockClose,
      setQuery: mockSetQuery,
      selectItem: mockSelectItem,
      selectSuggestion: mockSelectSuggestion,
    },
  })),
}));

vi.mock('@/components/providers/SuggestionProvider', () => ({
  useSuggestionContext: () => mockContextState,
}));

vi.mock('@/services/positioningService', () => ({
  positioningService: {
    calculateTextareaPosition: vi.fn(() => ({ top: 100, left: 200 })),
    calculateInlinePosition: vi.fn(() => ({ top: 50, left: 100 })),
  },
}));

vi.mock('@/lib/mentions/mentionConfig', () => ({
  MentionFormatter: {
    format: vi.fn((label: string) => `@${label}`),
  },
}));

import { useSuggestion } from '../useSuggestion';

describe('useSuggestion', () => {
  const mockOnValueChange = vi.fn();

  function createInputRef() {
    const textarea = document.createElement('textarea');
    return { current: textarea };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockContextState.isOpen = false;
    mockContextState.items = [];
    mockContextState.selectedIndex = 0;
    mockContextState.loading = false;
    mockContextState.error = null;
  });

  describe('initial state', () => {
    it('should return isOpen=false initially', () => {
      const inputRef = createInputRef();
      const { result } = renderHook(() =>
        useSuggestion({
          inputRef: inputRef as React.RefObject<HTMLTextAreaElement>,
          onValueChange: mockOnValueChange,
        })
      );

      expect(result.current.isOpen).toBe(false);
    });

    it('should return empty items initially', () => {
      const inputRef = createInputRef();
      const { result } = renderHook(() =>
        useSuggestion({
          inputRef: inputRef as React.RefObject<HTMLTextAreaElement>,
          onValueChange: mockOnValueChange,
        })
      );

      expect(result.current.items).toEqual([]);
    });

    it('should return selectedIndex=0 initially', () => {
      const inputRef = createInputRef();
      const { result } = renderHook(() =>
        useSuggestion({
          inputRef: inputRef as React.RefObject<HTMLTextAreaElement>,
          onValueChange: mockOnValueChange,
        })
      );

      expect(result.current.selectedIndex).toBe(0);
    });
  });

  describe('handleKeyDown', () => {
    it('should not handle keys when popup is closed', () => {
      const inputRef = createInputRef();
      mockContextState.isOpen = false;

      const { result } = renderHook(() =>
        useSuggestion({
          inputRef: inputRef as React.RefObject<HTMLTextAreaElement>,
          onValueChange: mockOnValueChange,
        })
      );

      const event = {
        key: 'ArrowDown',
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      } as unknown as React.KeyboardEvent;

      act(() => {
        result.current.handleKeyDown(event);
      });

      expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it('should not handle keys when items are empty', () => {
      const inputRef = createInputRef();
      mockContextState.isOpen = true;
      mockContextState.items = [];

      const { result } = renderHook(() =>
        useSuggestion({
          inputRef: inputRef as React.RefObject<HTMLTextAreaElement>,
          onValueChange: mockOnValueChange,
        })
      );

      const event = {
        key: 'ArrowDown',
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      } as unknown as React.KeyboardEvent;

      act(() => {
        result.current.handleKeyDown(event);
      });

      expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it('should handle ArrowDown when popup is open with items', () => {
      const inputRef = createInputRef();
      mockContextState.isOpen = true;
      mockContextState.items = [
        { id: '1', label: 'Alice', type: 'user', data: {} },
        { id: '2', label: 'Bob', type: 'user', data: {} },
      ];
      mockContextState.selectedIndex = 0;

      const { result } = renderHook(() =>
        useSuggestion({
          inputRef: inputRef as React.RefObject<HTMLTextAreaElement>,
          onValueChange: mockOnValueChange,
        })
      );

      const event = {
        key: 'ArrowDown',
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      } as unknown as React.KeyboardEvent;

      act(() => {
        result.current.handleKeyDown(event);
      });

      expect(event.preventDefault).toHaveBeenCalled();
      expect(event.stopPropagation).toHaveBeenCalled();
      expect(mockSelectItem).toHaveBeenCalledWith(1);
    });

    it('should handle ArrowUp when popup is open with items', () => {
      const inputRef = createInputRef();
      mockContextState.isOpen = true;
      mockContextState.items = [
        { id: '1', label: 'Alice', type: 'user', data: {} },
        { id: '2', label: 'Bob', type: 'user', data: {} },
      ];
      mockContextState.selectedIndex = 1;

      const { result } = renderHook(() =>
        useSuggestion({
          inputRef: inputRef as React.RefObject<HTMLTextAreaElement>,
          onValueChange: mockOnValueChange,
        })
      );

      const event = {
        key: 'ArrowUp',
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      } as unknown as React.KeyboardEvent;

      act(() => {
        result.current.handleKeyDown(event);
      });

      expect(event.preventDefault).toHaveBeenCalled();
      expect(event.stopPropagation).toHaveBeenCalled();
      expect(mockSelectItem).toHaveBeenCalledWith(0);
    });

    it('should handle Escape to close popup', () => {
      const inputRef = createInputRef();
      mockContextState.isOpen = true;
      mockContextState.items = [
        { id: '1', label: 'Alice', type: 'user', data: {} },
      ];

      const { result } = renderHook(() =>
        useSuggestion({
          inputRef: inputRef as React.RefObject<HTMLTextAreaElement>,
          onValueChange: mockOnValueChange,
        })
      );

      const event = {
        key: 'Escape',
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      } as unknown as React.KeyboardEvent;

      act(() => {
        result.current.handleKeyDown(event);
      });

      expect(event.preventDefault).toHaveBeenCalled();
      expect(mockClose).toHaveBeenCalled();
    });

    it('should handle Enter to select current item', () => {
      const inputRef = createInputRef();
      const selectedItem = { id: '1', label: 'Alice', type: 'user', data: {} };
      mockContextState.isOpen = true;
      mockContextState.items = [selectedItem];
      mockContextState.selectedIndex = 0;

      const { result } = renderHook(() =>
        useSuggestion({
          inputRef: inputRef as React.RefObject<HTMLTextAreaElement>,
          onValueChange: mockOnValueChange,
        })
      );

      const event = {
        key: 'Enter',
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      } as unknown as React.KeyboardEvent;

      act(() => {
        result.current.handleKeyDown(event);
      });

      expect(event.preventDefault).toHaveBeenCalled();
      expect(mockSelectSuggestion).toHaveBeenCalledWith(selectedItem);
    });

    it('should wrap ArrowDown from last to first item', () => {
      const inputRef = createInputRef();
      mockContextState.isOpen = true;
      mockContextState.items = [
        { id: '1', label: 'Alice', type: 'user', data: {} },
        { id: '2', label: 'Bob', type: 'user', data: {} },
      ];
      mockContextState.selectedIndex = 1;

      const { result } = renderHook(() =>
        useSuggestion({
          inputRef: inputRef as React.RefObject<HTMLTextAreaElement>,
          onValueChange: mockOnValueChange,
        })
      );

      const event = {
        key: 'ArrowDown',
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      } as unknown as React.KeyboardEvent;

      act(() => {
        result.current.handleKeyDown(event);
      });

      expect(mockSelectItem).toHaveBeenCalledWith(0);
    });

    it('should wrap ArrowUp from first to last item', () => {
      const inputRef = createInputRef();
      mockContextState.isOpen = true;
      mockContextState.items = [
        { id: '1', label: 'Alice', type: 'user', data: {} },
        { id: '2', label: 'Bob', type: 'user', data: {} },
      ];
      mockContextState.selectedIndex = 0;

      const { result } = renderHook(() =>
        useSuggestion({
          inputRef: inputRef as React.RefObject<HTMLTextAreaElement>,
          onValueChange: mockOnValueChange,
        })
      );

      const event = {
        key: 'ArrowUp',
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      } as unknown as React.KeyboardEvent;

      act(() => {
        result.current.handleKeyDown(event);
      });

      expect(mockSelectItem).toHaveBeenCalledWith(1);
    });
  });

  describe('handleValueChange', () => {
    it('should propagate value change to onValueChange', () => {
      const inputRef = createInputRef();

      const { result } = renderHook(() =>
        useSuggestion({
          inputRef: inputRef as React.RefObject<HTMLTextAreaElement>,
          onValueChange: mockOnValueChange,
        })
      );

      act(() => {
        result.current.handleValueChange('hello');
      });

      expect(mockOnValueChange).toHaveBeenCalledWith('hello');
    });
  });

  describe('actions', () => {
    it('should expose selectSuggestion action', () => {
      const inputRef = createInputRef();

      const { result } = renderHook(() =>
        useSuggestion({
          inputRef: inputRef as React.RefObject<HTMLTextAreaElement>,
          onValueChange: mockOnValueChange,
        })
      );

      expect(result.current.actions.selectSuggestion).toBeInstanceOf(Function);
    });

    it('should expose selectItem action', () => {
      const inputRef = createInputRef();

      const { result } = renderHook(() =>
        useSuggestion({
          inputRef: inputRef as React.RefObject<HTMLTextAreaElement>,
          onValueChange: mockOnValueChange,
        })
      );

      expect(result.current.actions.selectItem).toBeInstanceOf(Function);
    });
  });
});
