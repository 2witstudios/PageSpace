import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

import { useTouchDevice } from '../useTouchDevice';

/**
 * Pins the hook to `detectCoarsePointer`. Without this, reverting `getSnapshot`
 * to a bare `matchMedia('(pointer: coarse)')` check — the obvious-looking
 * simplification — passes every other test in the suite while silently
 * re-breaking every JS-hover affordance on a desktop-class iPad.
 */
vi.mock('@/lib/pointer-capability', () => ({
  detectCoarsePointer: vi.fn(() => false),
}));

const { detectCoarsePointer } = await import('@/lib/pointer-capability');
const detectMock = vi.mocked(detectCoarsePointer);

afterEach(() => {
  detectMock.mockReset();
});

describe('useTouchDevice', () => {
  it('reports touch when detectCoarsePointer says so', () => {
    detectMock.mockReturnValue(true);
    const { result } = renderHook(() => useTouchDevice());
    expect(result.current).toBe(true);
  });

  it('reports no touch when detectCoarsePointer says so', () => {
    detectMock.mockReturnValue(false);
    const { result } = renderHook(() => useTouchDevice());
    expect(result.current).toBe(false);
  });

  it('does not decide on its own — the verdict comes from detectCoarsePointer', () => {
    // jsdom's matchMedia stub always reports `matches: false` (see test/setup.ts).
    // A hook that consulted the media query directly could never return true here.
    detectMock.mockReturnValue(true);
    const { result } = renderHook(() => useTouchDevice());

    expect(detectMock).toHaveBeenCalled();
    expect(result.current).toBe(true);
  });
});
