import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useVirtualizationMode } from '../useVirtualizationMode';

describe('useVirtualizationMode', () => {
  it('given an already-long conversation on first render, should virtualize immediately', () => {
    // The ref is seeded from the first `desired`, so opening a long thread does not
    // render every message as plain DOM and then swap.
    const { result } = renderHook(() => useVirtualizationMode(true, false));
    expect(result.current).toBe(true);
  });

  it('given a long conversation that opens while a stream is already running, should still virtualize immediately', () => {
    const { result } = renderHook(() => useVirtualizationMode(true, true));
    expect(result.current).toBe(true);
  });

  it('given the threshold crossed mid-stream, should hold the previous mode until the stream settles', () => {
    const { result, rerender } = renderHook(
      ({ desired, streaming }) => useVirtualizationMode(desired, streaming),
      { initialProps: { desired: false, streaming: false } }
    );
    expect(result.current).toBe(false);

    // Stream starts, then the streaming message pushes the count over the threshold.
    rerender({ desired: false, streaming: true });
    rerender({ desired: true, streaming: true });
    expect(result.current).toBe(false);

    // More parts arrive; still deferred.
    rerender({ desired: true, streaming: true });
    expect(result.current).toBe(false);

    // Stream settles: the crossing lands now, with nothing arriving on screen.
    rerender({ desired: true, streaming: false });
    expect(result.current).toBe(true);
  });

  it('given the mode has crossed, should stay crossed across later streams', () => {
    const { result, rerender } = renderHook(
      ({ desired, streaming }) => useVirtualizationMode(desired, streaming),
      { initialProps: { desired: true, streaming: false } }
    );

    rerender({ desired: true, streaming: true });
    expect(result.current).toBe(true);
  });

  it('given StrictMode double-rendering, should produce the same answer as a single render', () => {
    // The hook writes its ref during render. That is only safe because the result
    // is a pure function of (desired, isStreaming, previous) and re-running
    // converges — so a second (or discarded) render pass cannot advance it past
    // where one pass would land.
    const { result, rerender } = renderHook(
      ({ desired, streaming }) => useVirtualizationMode(desired, streaming),
      {
        initialProps: { desired: false, streaming: false },
        wrapper: ({ children }) => React.createElement(React.StrictMode, null, children),
      }
    );
    expect(result.current).toBe(false);

    rerender({ desired: true, streaming: true });
    expect(result.current).toBe(false);

    rerender({ desired: true, streaming: true });
    expect(result.current).toBe(false);

    rerender({ desired: true, streaming: false });
    expect(result.current).toBe(true);

    // And it stays put once the stream restarts.
    rerender({ desired: true, streaming: true });
    expect(result.current).toBe(true);
  });

  it('given the stream ends, should always be able to leave a deferred state', () => {
    // Guards against a deferral that could latch: whatever `desired` wants is
    // adopted the moment isStreaming goes false, with no further conditions.
    const { result, rerender } = renderHook(
      ({ desired, streaming }) => useVirtualizationMode(desired, streaming),
      { initialProps: { desired: false, streaming: true } }
    );

    for (let i = 0; i < 5; i++) rerender({ desired: true, streaming: true });
    expect(result.current).toBe(false);

    rerender({ desired: true, streaming: false });
    expect(result.current).toBe(true);
  });

  it('given messages deleted mid-stream, should hold rather than drop back to plain rows', () => {
    const { result, rerender } = renderHook(
      ({ desired, streaming }) => useVirtualizationMode(desired, streaming),
      { initialProps: { desired: true, streaming: false } }
    );
    expect(result.current).toBe(true);

    rerender({ desired: false, streaming: true });
    expect(result.current).toBe(true);

    rerender({ desired: false, streaming: false });
    expect(result.current).toBe(false);
  });
});
