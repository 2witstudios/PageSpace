/**
 * Hook for tracking manually-toggled tool-call expand state.
 * Shared between MessageRenderer and CompactMessageRenderer.
 */

import { useCallback, useState } from 'react';

/**
 * Tracks manually-toggled tool-call expand/collapse state, keyed by
 * toolCallId rather than render position. Lives in MessageRenderer /
 * CompactMessageRenderer — an ancestor that never remounts — so a
 * toolCallId's open state survives the standalone -> ToolRunGroup structural
 * change that happens when useGroupedParts retroactively folds a lone call
 * into a run (the resulting key/type change forces React to remount that
 * slot, which would otherwise silently discard the row's uncontrolled
 * Collapsible state).
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
