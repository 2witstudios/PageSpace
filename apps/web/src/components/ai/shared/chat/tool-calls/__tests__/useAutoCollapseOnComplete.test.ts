import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAutoCollapseOnComplete, type RunStatus } from '../useAutoCollapseOnComplete';

describe('useAutoCollapseOnComplete', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts open while running', () => {
    const { result } = renderHook(() => useAutoCollapseOnComplete('running'));
    expect(result.current.open).toBe(true);
  });

  it('starts closed when mounted already complete (e.g. loaded from history)', () => {
    const { result } = renderHook(() => useAutoCollapseOnComplete('complete'));
    expect(result.current.open).toBe(false);

    // No delayed close should ever fire for a group that started closed.
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(result.current.open).toBe(false);
  });

  it('does not collapse during a running -> complete -> running oscillation', () => {
    const { result, rerender } = renderHook(
      ({ status }: { status: RunStatus }) => useAutoCollapseOnComplete(status),
      { initialProps: { status: 'running' as RunStatus } },
    );
    expect(result.current.open).toBe(true);

    // Call N's output part arrives; no further calls known yet.
    rerender({ status: 'complete' });
    expect(result.current.open).toBe(true); // no immediate collapse

    act(() => {
      vi.advanceTimersByTime(300); // partway through the debounce window
    });
    expect(result.current.open).toBe(true);

    // Call N+1's input part streams in before the debounce fires.
    rerender({ status: 'running' });
    expect(result.current.open).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1000); // past where the original close would have fired
    });
    expect(result.current.open).toBe(true); // pending close was cancelled, not just delayed
  });

  it('stays open through 3 sequential tool calls, then closes once after the last one', () => {
    // A real agent turn: each call completes before the next starts, so
    // status genuinely bounces complete -> running between every step.
    const { result, rerender } = renderHook(
      ({ status }: { status: RunStatus }) => useAutoCollapseOnComplete(status),
      { initialProps: { status: 'running' as RunStatus } },
    );

    // Call 1 completes, call 2 starts before the debounce fires.
    rerender({ status: 'complete' });
    act(() => { vi.advanceTimersByTime(400); });
    expect(result.current.open).toBe(true);
    rerender({ status: 'running' });
    expect(result.current.open).toBe(true);

    // Call 2 completes, call 3 starts before the debounce fires.
    rerender({ status: 'complete' });
    act(() => { vi.advanceTimersByTime(700); });
    expect(result.current.open).toBe(true);
    rerender({ status: 'running' });
    expect(result.current.open).toBe(true);

    // Call 3 completes — this time nothing else starts, so the debounce
    // should run to completion and close the group exactly once.
    rerender({ status: 'complete' });
    act(() => { vi.advanceTimersByTime(999); });
    expect(result.current.open).toBe(true);
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current.open).toBe(false);

    // No further, redundant close should fire on subsequent idle re-renders.
    rerender({ status: 'complete' });
    act(() => { vi.advanceTimersByTime(5000); });
    expect(result.current.open).toBe(false);
  });

  it('collapses only after status holds complete for the full delay', () => {
    const { result, rerender } = renderHook(
      ({ status }: { status: RunStatus }) => useAutoCollapseOnComplete(status),
      { initialProps: { status: 'running' as RunStatus } },
    );

    rerender({ status: 'complete' });
    expect(result.current.open).toBe(true);

    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(result.current.open).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.open).toBe(false);
  });

  it('never auto-collapses on error, even after a long delay', () => {
    const { result } = renderHook(() => useAutoCollapseOnComplete('error'));
    expect(result.current.open).toBe(true);

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(result.current.open).toBe(true);
  });

  it('respects a manual close and does not reopen on later status changes', () => {
    const { result, rerender } = renderHook(
      ({ status }: { status: RunStatus }) => useAutoCollapseOnComplete(status),
      { initialProps: { status: 'running' as RunStatus } },
    );

    act(() => {
      result.current.onOpenChange(false);
    });
    expect(result.current.open).toBe(false);

    rerender({ status: 'complete' });
    rerender({ status: 'error' });
    rerender({ status: 'running' });
    expect(result.current.open).toBe(false);
  });

  it('respects a manual open and does not auto-close afterward', () => {
    const { result, rerender } = renderHook(
      ({ status }: { status: RunStatus }) => useAutoCollapseOnComplete(status),
      { initialProps: { status: 'complete' as RunStatus } },
    );
    expect(result.current.open).toBe(false);

    act(() => {
      result.current.onOpenChange(true);
    });
    expect(result.current.open).toBe(true);

    rerender({ status: 'complete' });
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(result.current.open).toBe(true);
  });
});
