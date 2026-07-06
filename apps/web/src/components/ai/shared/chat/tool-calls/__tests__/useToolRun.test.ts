import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useState, useCallback } from 'react';
import { useToolRun } from '../useToolRun';
import type { ProcessedToolPart } from '../../message-types';

function part(overrides: { toolCallId: string; toolName: string; state?: ProcessedToolPart['state'] }): ProcessedToolPart {
  return {
    type: `tool-${overrides.toolName}`,
    toolCallId: overrides.toolCallId,
    toolName: overrides.toolName,
    input: {},
    output: { ok: true },
    state: overrides.state ?? 'output-available',
  };
}

/** Mirrors useToolCallOpenState's real Map-based behavior for these unit tests. */
function useOpenStateMap() {
  const [overrides, setOverrides] = useState<Map<string, boolean>>(() => new Map());
  const getToolCallOpen = useCallback((key: string) => overrides.get(key), [overrides]);
  const setToolCallOpen = useCallback((key: string, open: boolean) => {
    setOverrides(prev => new Map(prev).set(key, open));
  }, []);
  return { getToolCallOpen, setToolCallOpen };
}

describe('useToolRun', () => {
  it('given an untouched solo run, should default to closed', () => {
    const map = renderHook(() => useOpenStateMap());
    const { result } = renderHook(() =>
      useToolRun([part({ toolCallId: 'tc-1', toolName: 'bash' })], 'run:tc-1', map.result.current.getToolCallOpen, map.result.current.setToolCallOpen)
    );

    expect(result.current.isSolo).toBe(true);
    expect(result.current.open).toBe(false);
  });

  it('given the solo run is manually opened, should write both the runKey and the row key', () => {
    const map = renderHook(() => useOpenStateMap());
    const { result, rerender } = renderHook(() =>
      useToolRun([part({ toolCallId: 'tc-1', toolName: 'bash' })], 'run:tc-1', map.result.current.getToolCallOpen, map.result.current.setToolCallOpen)
    );

    act(() => result.current.onOpenChange(true));
    map.rerender();
    rerender();

    expect(map.result.current.getToolCallOpen('run:tc-1')).toBe(true);
    expect(map.result.current.getToolCallOpen('tc-1')).toBe(true);
    expect(result.current.open).toBe(true);
  });

  it('given a 2nd call joins after the group was manually opened, should stay open (same runKey, no reset)', () => {
    const map = renderHook(() => useOpenStateMap());
    const { result, rerender } = renderHook(
      ({ parts }: { parts: ProcessedToolPart[] }) => useToolRun(parts, 'run:tc-1', map.result.current.getToolCallOpen, map.result.current.setToolCallOpen),
      { initialProps: { parts: [part({ toolCallId: 'tc-1', toolName: 'bash' })] } }
    );

    act(() => result.current.onOpenChange(true));
    map.rerender();
    rerender({ parts: [part({ toolCallId: 'tc-1', toolName: 'bash' }), part({ toolCallId: 'tc-2', toolName: 'read_page', state: 'input-available' })] });

    expect(result.current.isSolo).toBe(false);
    expect(result.current.open).toBe(true);
  });

  it('given the head row was manually expanded specifically while grouped, and the run later shrinks back to solo, should still read open (falls back to the row key)', () => {
    // Reproduces the Altitude-angle finding: a user expands the FIRST
    // member's own nested row (not the group header) while the run is 2+
    // long — that toggle writes the raw toolCallId key, not runKey. If the
    // run later shrinks back to solo (its 2nd member reclassified as
    // standalone — e.g. an execute_tool call resolving to a diff tool once
    // its streamed input completes), the solo view must not silently drop
    // that manual expand by only checking runKey.
    const map = renderHook(() => useOpenStateMap());

    // Simulate: while grouped, the nested row for tc-1 (not the group
    // header) was toggled open — this writes key 'tc-1' directly, the same
    // key the parts.map in GroupRunBody/ CompactToolRunGroup's group branch
    // uses, and the same key useToolRun's solo fallback checks.
    act(() => map.result.current.setToolCallOpen('tc-1', true));
    map.rerender();

    // Run shrinks back to solo containing only tc-1. The group header's own
    // key ('run:tc-1') was never toggled — only the row's key was.
    const { result } = renderHook(() =>
      useToolRun([part({ toolCallId: 'tc-1', toolName: 'bash' })], 'run:tc-1', map.result.current.getToolCallOpen, map.result.current.setToolCallOpen)
    );

    expect(result.current.isSolo).toBe(true);
    expect(result.current.open).toBe(true);
  });

  it('given a run of 2+, should resolve soloToolName/soloPart from the effective (unwrapped) first call even though they are unused', () => {
    const map = renderHook(() => useOpenStateMap());
    const parts = [
      part({ toolCallId: 'tc-1', toolName: 'bash' }),
      part({ toolCallId: 'tc-2', toolName: 'read_page' }),
    ];
    const { result } = renderHook(() =>
      useToolRun(parts, 'run:tc-1', map.result.current.getToolCallOpen, map.result.current.setToolCallOpen)
    );

    expect(result.current.isSolo).toBe(false);
    expect(result.current.soloToolName).toBe('bash');
    expect(result.current.status).toBe('complete');
  });
});
