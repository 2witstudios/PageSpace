import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useToolCallOpenState } from '../useToolCallOpenState';

describe('useToolCallOpenState', () => {
  it('returns undefined for a toolCallId with no recorded override', () => {
    const { result } = renderHook(() => useToolCallOpenState());
    expect(result.current.getToolCallOpen('tc-1')).toBeUndefined();
  });

  it('records and returns a manual toggle for a given toolCallId', () => {
    const { result } = renderHook(() => useToolCallOpenState());

    act(() => {
      result.current.setToolCallOpen('tc-1', true);
    });
    expect(result.current.getToolCallOpen('tc-1')).toBe(true);

    act(() => {
      result.current.setToolCallOpen('tc-1', false);
    });
    expect(result.current.getToolCallOpen('tc-1')).toBe(false);
  });

  it('keeps overrides independent per toolCallId', () => {
    const { result } = renderHook(() => useToolCallOpenState());

    act(() => {
      result.current.setToolCallOpen('tc-1', true);
      result.current.setToolCallOpen('tc-2', false);
    });

    expect(result.current.getToolCallOpen('tc-1')).toBe(true);
    expect(result.current.getToolCallOpen('tc-2')).toBe(false);
    expect(result.current.getToolCallOpen('tc-3')).toBeUndefined();
  });

  it('survives across re-renders (state lives in this hook instance, not the caller)', () => {
    const { result, rerender } = renderHook(() => useToolCallOpenState());

    act(() => {
      result.current.setToolCallOpen('tc-1', true);
    });
    rerender();

    expect(result.current.getToolCallOpen('tc-1')).toBe(true);
  });
});
