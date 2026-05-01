import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

import { useGlobalEffectiveStream } from '../useGlobalEffectiveStream';

describe('useGlobalEffectiveStream', () => {
  // AC9
  it('given global mode with local idle and context isStreaming=true, should report effectiveIsStreaming=true', () => {
    const { result } = renderHook(() =>
      useGlobalEffectiveStream({
        localIsStreaming: false,
        rawStop: vi.fn(),
        selectedAgent: null,
        contextIsStreaming: true,
        contextStopStreaming: vi.fn(),
      }),
    );

    expect(result.current.effectiveIsStreaming).toBe(true);
  });

  // AC10
  it('given global mode with local idle and context stopStreaming set, should dispatch effectiveStop to context', () => {
    const rawStop = vi.fn();
    const contextStopStreaming = vi.fn();

    const { result } = renderHook(() =>
      useGlobalEffectiveStream({
        localIsStreaming: false,
        rawStop,
        selectedAgent: null,
        contextIsStreaming: true,
        contextStopStreaming,
      }),
    );

    result.current.effectiveStop();

    expect(contextStopStreaming).toHaveBeenCalledTimes(1);
    expect(rawStop).not.toHaveBeenCalled();
  });

  // AC11
  it('given local stream is active, should call rawStop and not the context stop', () => {
    const rawStop = vi.fn();
    const contextStopStreaming = vi.fn();

    const { result } = renderHook(() =>
      useGlobalEffectiveStream({
        localIsStreaming: true,
        rawStop,
        selectedAgent: null,
        contextIsStreaming: true,
        contextStopStreaming,
      }),
    );

    result.current.effectiveStop();

    expect(rawStop).toHaveBeenCalledTimes(1);
    expect(contextStopStreaming).not.toHaveBeenCalled();
  });

  // AC12
  it('given an agent is selected, should ignore the context streaming flags', () => {
    const { result } = renderHook(() =>
      useGlobalEffectiveStream({
        localIsStreaming: false,
        rawStop: vi.fn(),
        selectedAgent: { id: 'agent-1' },
        contextIsStreaming: true,
        contextStopStreaming: vi.fn(),
      }),
    );

    expect(result.current.effectiveIsStreaming).toBe(false);
  });

  it('given an agent is selected with local streaming, should still call rawStop on stop', () => {
    const rawStop = vi.fn();
    const contextStopStreaming = vi.fn();

    const { result } = renderHook(() =>
      useGlobalEffectiveStream({
        localIsStreaming: true,
        rawStop,
        selectedAgent: { id: 'agent-1' },
        contextIsStreaming: true,
        contextStopStreaming,
      }),
    );

    result.current.effectiveStop();

    expect(rawStop).toHaveBeenCalledTimes(1);
    expect(contextStopStreaming).not.toHaveBeenCalled();
  });

  it('given idle in agent mode with no rawStop, calling effectiveStop should be a no-op', () => {
    const rawStop = vi.fn();
    const contextStopStreaming = vi.fn();

    const { result } = renderHook(() =>
      useGlobalEffectiveStream({
        localIsStreaming: false,
        rawStop,
        selectedAgent: { id: 'agent-1' },
        contextIsStreaming: false,
        contextStopStreaming,
      }),
    );

    result.current.effectiveStop();

    expect(rawStop).not.toHaveBeenCalled();
    expect(contextStopStreaming).not.toHaveBeenCalled();
  });

  it('given idle global mode with no context stop, calling effectiveStop should be a no-op', () => {
    const rawStop = vi.fn();

    const { result } = renderHook(() =>
      useGlobalEffectiveStream({
        localIsStreaming: false,
        rawStop,
        selectedAgent: null,
        contextIsStreaming: false,
        contextStopStreaming: null,
      }),
    );

    result.current.effectiveStop();

    expect(rawStop).not.toHaveBeenCalled();
  });
});
