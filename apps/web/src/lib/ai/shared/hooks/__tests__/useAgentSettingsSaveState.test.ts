import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAgentSettingsSaveState } from '../useAgentSettingsSaveState';

describe('useAgentSettingsSaveState', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts clean, and only reaches dirty once setIsDirty(true) is called', () => {
    const { result } = renderHook(() => useAgentSettingsSaveState());

    expect(result.current.saveState).toBe('clean');

    act(() => result.current.setIsDirty(true));

    expect(result.current.saveState).toBe('dirty');
  });

  it('reports saving whenever setIsSaving(true) is set, regardless of dirty state', () => {
    const { result } = renderHook(() => useAgentSettingsSaveState());

    act(() => result.current.setIsDirty(true));
    act(() => result.current.setIsSaving(true));

    expect(result.current.saveState).toBe('saving');
  });

  it('shows saved after handleSaved(), then reverts to clean once the confirmation window elapses', () => {
    const { result } = renderHook(() => useAgentSettingsSaveState());

    act(() => result.current.setIsDirty(true));
    // Mirrors the real flow: a successful save resets dirty around the same
    // time onSaved fires (see AgentPageView/AgentPanes wiring).
    act(() => {
      result.current.setIsDirty(false);
      result.current.handleSaved();
    });

    expect(result.current.saveState).toBe('saved');

    act(() => vi.advanceTimersByTime(1799));
    expect(result.current.saveState).toBe('saved');

    act(() => vi.advanceTimersByTime(1));
    expect(result.current.saveState).toBe('clean');
  });

  it('lets a new edit during the saved window immediately override it back to dirty', () => {
    const { result } = renderHook(() => useAgentSettingsSaveState());

    act(() => {
      result.current.setIsDirty(true);
      result.current.setIsDirty(false);
      result.current.handleSaved();
    });
    expect(result.current.saveState).toBe('saved');

    act(() => result.current.setIsDirty(true));
    expect(result.current.saveState).toBe('dirty');

    // The still-pending "revert to clean" timeout from the earlier save must
    // not clobber this fresh edit once it fires.
    act(() => vi.advanceTimersByTime(1800));
    expect(result.current.saveState).toBe('dirty');
  });

  it('debounces back-to-back saves — a second handleSaved() call resets the confirmation window instead of stacking timers', () => {
    const { result } = renderHook(() => useAgentSettingsSaveState());

    act(() => result.current.handleSaved());
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.saveState).toBe('saved');

    // A second save arrives before the first confirmation window closed.
    act(() => result.current.handleSaved());
    act(() => vi.advanceTimersByTime(1000));
    // Only 1000ms since the SECOND call — the window should not have closed
    // yet if the timer was correctly restarted rather than left stacked.
    expect(result.current.saveState).toBe('saved');

    act(() => vi.advanceTimersByTime(800));
    expect(result.current.saveState).toBe('clean');
  });

  it('forces clean whenever isConfigLoaded is false, even while dirty', () => {
    const { result, rerender } = renderHook(
      ({ isConfigLoaded }: { isConfigLoaded: boolean }) => useAgentSettingsSaveState({ isConfigLoaded }),
      { initialProps: { isConfigLoaded: false } },
    );

    act(() => result.current.setIsDirty(true));
    expect(result.current.saveState).toBe('clean');

    rerender({ isConfigLoaded: true });
    expect(result.current.saveState).toBe('dirty');
  });

  it('clears the pending revert-to-clean timeout on unmount, without throwing', () => {
    const { result, unmount } = renderHook(() => useAgentSettingsSaveState());

    act(() => result.current.handleSaved());
    unmount();

    expect(() => act(() => vi.advanceTimersByTime(5000))).not.toThrow();
  });
});
