/**
 * Hook for tracking manually-toggled tool-call expand state.
 * Shared between MessageRenderer and CompactMessageRenderer.
 */

import { useCallback, useState } from 'react';

/**
 * Tracks manually-toggled tool-call expand/collapse state, keyed by
 * toolCallId rather than render position. Lives in MessageRenderer /
 * CompactMessageRenderer — an ancestor that never remounts — so state
 * survives useGroupedParts recomputing groups as a message streams in.
 *
 * Holds two id-spaces in the same map: a nested row's own toolCallId, and a
 * run's own header open state keyed by its `runKey` (see message-types.ts's
 * ToolRunGroupPart) — always closed by default when absent, exactly like a
 * standalone tool call. runKey is derived from a toolCallId with a `run:`
 * prefix, so the two spaces never collide.
 *
 * Absence of an entry means "no manual toggle yet" — callers should treat
 * `undefined` as "use the component's own default" rather than a boolean.
 */
export function useToolCallOpenState() {
  const [overrides, setOverrides] = useState<Map<string, boolean>>(() => new Map());

  const getToolCallOpen = useCallback(
    (toolCallId: string): boolean | undefined => overrides.get(toolCallId),
    [overrides]
  );

  const setToolCallOpen = useCallback((toolCallId: string, open: boolean) => {
    setOverrides(prev => {
      const next = new Map(prev);
      next.set(toolCallId, open);
      return next;
    });
  }, []);

  return { getToolCallOpen, setToolCallOpen } as const;
}
