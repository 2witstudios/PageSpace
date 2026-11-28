import { useMemo } from 'react';
import { dispatchToolCall } from './tool-call-dispatch';
import { TASK_TOOL_NAMES } from '../useAggregatedTasks';
import { computeToolRunStatus } from './tool-significance';
import type { ProcessedToolPart } from '../message-types';

/**
 * Shared, non-visual identity/open-state logic for a tool-call run, used by
 * both ToolRunGroup.tsx (main surface) and CompactToolRunGroup.tsx (sidebar)
 * so the two presentations can't silently drift on how a run's open state or
 * solo dispatch is resolved.
 *
 * `open` falls back from `runKey` to the solo row's own key (and vice versa
 * via onOpenChange's dual write) because a run's identity and its sole
 * member's row identity are the same concept while solo, but only rejoin as
 * the same key going forward if a run that grew back to solo (e.g. a later
 * execute_tool call resolving to a standalone diff tool once its streamed
 * input completes) had its head row manually toggled while still part of a
 * 2+ group — that toggle lives under the row's own toolCallId, not runKey.
 */
export function useToolRun(
  parts: ProcessedToolPart[],
  runKey: string,
  getToolCallOpen: (key: string) => boolean | undefined,
  setToolCallOpen: (key: string, open: boolean) => void
) {
  const isSolo = parts.length === 1;
  const soloRowKey = parts[0].toolCallId || `${parts[0].type}-0`;

  const open = isSolo
    ? getToolCallOpen(runKey) ?? getToolCallOpen(soloRowKey) ?? false
    : getToolCallOpen(runKey) ?? false;

  const onOpenChange = (next: boolean) => {
    setToolCallOpen(runKey, next);
    if (isSolo) {
      setToolCallOpen(soloRowKey, next);
    }
  };

  const status = useMemo(() => computeToolRunStatus(parts), [parts]);

  // Every part in a run dispatches 'generic' by construction — diff/task/
  // agent tools are filtered out before a run is ever built (see
  // isStandaloneTool in tool-significance.ts, whose SPECIAL_HANDLED_TOOLS
  // set matches dispatchToolCall's 'task'/'agent' classification exactly).
  const soloDispatch = useMemo(() => dispatchToolCall(parts[0], TASK_TOOL_NAMES), [parts]);
  const soloToolName = soloDispatch.kind === 'generic' ? soloDispatch.toolName : (parts[0].toolName || 'unknown_tool');
  const soloPart = soloDispatch.kind === 'generic' ? soloDispatch.part : parts[0];

  return { isSolo, open, onOpenChange, status, soloToolName, soloPart };
}
