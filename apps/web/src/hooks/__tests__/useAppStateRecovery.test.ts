import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('@/hooks/useCapacitor', () => ({
  isCapacitorApp: () => false,
}));

import { useAppStateRecovery } from '../useAppStateRecovery';

const BACKGROUND_MS = 10_000;

/** Drive the web visibilitychange path: hide, wait out minBackgroundTime, show. */
const backgroundThenResume = async (backgroundedForMs = BACKGROUND_MS) => {
  const realNow = Date.now();
  const nowSpy = vi.spyOn(Date, 'now');

  nowSpy.mockReturnValue(realNow);
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });

  nowSpy.mockReturnValue(realNow + backgroundedForMs);
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await Promise.resolve(); });

  nowSpy.mockRestore();
};

describe('useAppStateRecovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('given enabled=true, should call onResume after a long-enough background', async () => {
    const onResume = vi.fn();
    renderHook(() => useAppStateRecovery({ onResume, enabled: true }));

    await backgroundThenResume();

    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it('given enabled=false, should not call onResume', async () => {
    const onResume = vi.fn();
    renderHook(() => useAppStateRecovery({ onResume, enabled: false }));

    await backgroundThenResume();

    expect(onResume).not.toHaveBeenCalled();
  });

  it('given a background shorter than minBackgroundTime, should not call onResume', async () => {
    const onResume = vi.fn();
    renderHook(() => useAppStateRecovery({ onResume, enabled: true, minBackgroundTime: 5000 }));

    await backgroundThenResume(1000);

    expect(onResume).not.toHaveBeenCalled();
  });

  // AC4. This is the whole point of the callback form. A boolean `enabled` is captured
  // at RENDER — and iOS freezes JS the moment the app backgrounds, so the value that
  // ends up gating the resume is whatever was true when the app went away. On the AI
  // page that value was "a stream is running", i.e. the hook disabled itself in exactly
  // the case it was written for.
  describe('enabled as a callback — evaluated at fire time, not captured at render', () => {
    it('given a callback that flips false->true while backgrounded (no re-render), should call onResume', async () => {
      const onResume = vi.fn();
      let allowed = false;

      renderHook(() => useAppStateRecovery({ onResume, enabled: () => allowed }));

      // The gate is false at render time. No re-render happens after this point —
      // exactly what a frozen, backgrounded WebView gives you.
      allowed = true;

      await backgroundThenResume();

      expect(onResume).toHaveBeenCalledTimes(1);
    });

    it('given a callback that flips true->false while backgrounded, should NOT call onResume', async () => {
      const onResume = vi.fn();
      let allowed = true;

      renderHook(() => useAppStateRecovery({ onResume, enabled: () => allowed }));

      allowed = false;

      await backgroundThenResume();

      expect(onResume).not.toHaveBeenCalled();
    });

    // Contrast: proves the boolean form really does capture at render, which is why the
    // AI page must pass a callback.
    it('given a BOOLEAN enabled that goes stale with no re-render, should use the stale value', async () => {
      const onResume = vi.fn();
      let allowed = false;

      const { rerender } = renderHook(() => useAppStateRecovery({ onResume, enabled: allowed }));
      rerender();

      allowed = true; // never re-rendered — the hook cannot see this

      await backgroundThenResume();

      expect(onResume).not.toHaveBeenCalled();
    });
  });
});
