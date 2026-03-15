/**
 * useBreakpoint Hook Tests
 * Tests for media query-based breakpoint detection using useSyncExternalStore
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useBreakpoint } from '../useBreakpoint';

type ChangeListener = () => void;

function createMockMatchMedia(matches: boolean) {
  let listeners: ChangeListener[] = [];

  const mql = {
    matches,
    media: '',
    addEventListener: vi.fn((event: string, listener: ChangeListener) => {
      if (event === 'change') {
        listeners.push(listener);
      }
    }),
    removeEventListener: vi.fn((event: string, listener: ChangeListener) => {
      if (event === 'change') {
        listeners = listeners.filter((l) => l !== listener);
      }
    }),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    onchange: null,
    dispatchEvent: vi.fn(),
  };

  return {
    mql,
    triggerChange: (newMatches: boolean) => {
      mql.matches = newMatches;
      listeners.forEach((l) => l());
    },
    getListenerCount: () => listeners.length,
  };
}

describe('useBreakpoint', () => {
  let mockMatchMedia: ReturnType<typeof createMockMatchMedia>;

  beforeEach(() => {
    mockMatchMedia = createMockMatchMedia(false);
    vi.stubGlobal('matchMedia', vi.fn(() => mockMatchMedia.mql));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should return true when the media query matches', () => {
    mockMatchMedia = createMockMatchMedia(true);
    vi.stubGlobal('matchMedia', vi.fn(() => mockMatchMedia.mql));

    const { result } = renderHook(() => useBreakpoint('(max-width: 768px)'));

    expect(result.current).toBe(true);
  });

  it('should return false when the media query does not match', () => {
    mockMatchMedia = createMockMatchMedia(false);
    vi.stubGlobal('matchMedia', vi.fn(() => mockMatchMedia.mql));

    const { result } = renderHook(() => useBreakpoint('(max-width: 768px)'));

    expect(result.current).toBe(false);
  });

  it('should call matchMedia with the provided query string', () => {
    renderHook(() => useBreakpoint('(min-width: 1024px)'));

    expect(window.matchMedia).toHaveBeenCalledWith('(min-width: 1024px)');
  });

  it('should update when the media query match state changes', () => {
    mockMatchMedia = createMockMatchMedia(false);
    vi.stubGlobal('matchMedia', vi.fn(() => mockMatchMedia.mql));

    const { result } = renderHook(() => useBreakpoint('(max-width: 768px)'));

    expect(result.current).toBe(false);

    act(() => {
      mockMatchMedia.triggerChange(true);
    });

    expect(result.current).toBe(true);
  });

  it('should register a change event listener', () => {
    renderHook(() => useBreakpoint('(max-width: 768px)'));

    expect(mockMatchMedia.mql.addEventListener).toHaveBeenCalledWith(
      'change',
      expect.any(Function)
    );
  });

  it('should remove the change event listener on unmount', () => {
    const { unmount } = renderHook(() => useBreakpoint('(max-width: 768px)'));

    unmount();

    expect(mockMatchMedia.mql.removeEventListener).toHaveBeenCalledWith(
      'change',
      expect.any(Function)
    );
  });

  it('should handle different query strings', () => {
    const queries = [
      '(max-width: 640px)',
      '(min-width: 1280px)',
      '(pointer: coarse)',
      '(prefers-color-scheme: dark)',
    ];

    for (const query of queries) {
      renderHook(() => useBreakpoint(query));
      expect(window.matchMedia).toHaveBeenCalledWith(query);
    }
  });

  it('should respond to multiple change events', () => {
    mockMatchMedia = createMockMatchMedia(false);
    vi.stubGlobal('matchMedia', vi.fn(() => mockMatchMedia.mql));

    const { result } = renderHook(() => useBreakpoint('(max-width: 768px)'));

    expect(result.current).toBe(false);

    act(() => {
      mockMatchMedia.triggerChange(true);
    });
    expect(result.current).toBe(true);

    act(() => {
      mockMatchMedia.triggerChange(false);
    });
    expect(result.current).toBe(false);
  });
});
