/**
 * useTouchDevice Hook Tests
 * Tests for touch device detection via matchMedia("(pointer: coarse)")
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

type ChangeListener = () => void;

function createMockMatchMedia(matches: boolean) {
  let listeners: ChangeListener[] = [];

  const mql = {
    matches,
    media: '(pointer: coarse)',
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
  };
}

describe('useTouchDevice', () => {
  let mockMatchMedia: ReturnType<typeof createMockMatchMedia>;
  let useTouchDeviceModule: typeof import('../useTouchDevice');

  beforeEach(async () => {
    vi.resetModules();
    mockMatchMedia = createMockMatchMedia(false);
    vi.stubGlobal('matchMedia', vi.fn(() => mockMatchMedia.mql));
    useTouchDeviceModule = await import('../useTouchDevice');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should return false when the device does not have a coarse pointer', () => {
    mockMatchMedia = createMockMatchMedia(false);
    vi.stubGlobal('matchMedia', vi.fn(() => mockMatchMedia.mql));

    const { result } = renderHook(() => useTouchDeviceModule.useTouchDevice());

    expect(result.current).toBe(false);
  });

  it('should return true when the device has a coarse pointer', async () => {
    vi.resetModules();
    mockMatchMedia = createMockMatchMedia(true);
    vi.stubGlobal('matchMedia', vi.fn(() => mockMatchMedia.mql));
    useTouchDeviceModule = await import('../useTouchDevice');

    const { result } = renderHook(() => useTouchDeviceModule.useTouchDevice());

    expect(result.current).toBe(true);
  });

  it('should query for "(pointer: coarse)" media', () => {
    renderHook(() => useTouchDeviceModule.useTouchDevice());

    expect(window.matchMedia).toHaveBeenCalledWith('(pointer: coarse)');
  });

  it('should update when pointer type changes', async () => {
    vi.resetModules();
    mockMatchMedia = createMockMatchMedia(false);
    vi.stubGlobal('matchMedia', vi.fn(() => mockMatchMedia.mql));
    useTouchDeviceModule = await import('../useTouchDevice');

    const { result } = renderHook(() => useTouchDeviceModule.useTouchDevice());

    expect(result.current).toBe(false);

    act(() => {
      mockMatchMedia.triggerChange(true);
    });

    expect(result.current).toBe(true);
  });

  it('should register a change event listener on the media query list', () => {
    renderHook(() => useTouchDeviceModule.useTouchDevice());

    expect(mockMatchMedia.mql.addEventListener).toHaveBeenCalledWith(
      'change',
      expect.any(Function)
    );
  });

  it('should clean up the event listener on unmount', () => {
    const { unmount } = renderHook(() => useTouchDeviceModule.useTouchDevice());

    unmount();

    expect(mockMatchMedia.mql.removeEventListener).toHaveBeenCalledWith(
      'change',
      expect.any(Function)
    );
  });
});
