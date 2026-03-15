/**
 * useHasHydrated Hook Tests
 * Tests for the hydration status wrapper around useLayoutStore
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

// Mock the layout store before importing the hook
vi.mock('@/stores/useLayoutStore', () => {
  const store = vi.fn();
  return { useLayoutStore: store };
});

import { useHasHydrated } from '../useHasHydrated';
import { useLayoutStore } from '@/stores/useLayoutStore';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockedUseLayoutStore = vi.mocked(useLayoutStore) as any;

describe('useHasHydrated', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return false when store has not rehydrated', () => {
    mockedUseLayoutStore.mockImplementation((selector: (state: { rehydrated: boolean }) => boolean) => {
      return selector({ rehydrated: false });
    });

    const { result } = renderHook(() => useHasHydrated());

    expect(result.current).toBe(false);
  });

  it('should return true when store has rehydrated', () => {
    mockedUseLayoutStore.mockImplementation((selector: (state: { rehydrated: boolean }) => boolean) => {
      return selector({ rehydrated: true });
    });

    const { result } = renderHook(() => useHasHydrated());

    expect(result.current).toBe(true);
  });

  it('should call useLayoutStore with a selector function', () => {
    mockedUseLayoutStore.mockImplementation((selector: (state: { rehydrated: boolean }) => boolean) => {
      return selector({ rehydrated: false });
    });

    renderHook(() => useHasHydrated());

    expect(mockedUseLayoutStore).toHaveBeenCalledWith(expect.any(Function));
  });

  it('should pass a selector that extracts the rehydrated field', () => {
    let capturedSelector: ((state: { rehydrated: boolean }) => boolean) | undefined;

    mockedUseLayoutStore.mockImplementation((selector: (state: { rehydrated: boolean }) => boolean) => {
      capturedSelector = selector;
      return selector({ rehydrated: true });
    });

    renderHook(() => useHasHydrated());

    expect(capturedSelector).toBeDefined();
    expect(capturedSelector!({ rehydrated: true })).toBe(true);
    expect(capturedSelector!({ rehydrated: false })).toBe(false);
  });
});
