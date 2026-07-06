import React, { useMemo } from 'react';
import { Tool, ToolContent, ToolHeader } from '@/components/ai/ui/tool';
import { ToolCallRenderer, TOOL_NAME_MAP, useToolCallDisplay, renderToolFallbackContent } from './ToolCallRenderer';
import { dispatchToolCall } from './tool-call-dispatch';
import { TASK_TOOL_NAMES } from '../useAggregatedTasks';
import { summarizeToolRun, computeToolRunStatus, type RunStatus } from './tool-significance';
import type { ProcessedToolPart } from '../message-types';

interface ToolRunGroupProps {
  /** Always 1+. A length-1 run renders identically to a standalone tool call. */
  parts: ProcessedToolPart[];
  /** Stable across the run's growth — see message-types.ts's ToolRunGroupPart. */
  runKey: string;
  /**
   * Reads/writes manually-toggled open state, keyed by toolCallId for a
   * nested row or by `runKey` for the run's own header, from an ancestor
   * that never remounts (MessageRenderer / CompactMessageRenderer). Always
   * closed by default (no auto-expand from running/error status) — the
   * user's manual choice is the only thing that opens it.
   */
  getToolCallOpen: (key: string) => boolean | undefined;
  setToolCallOpen: (key: string, open: boolean) => void;
}

const HEADER_STATE_FOR_STATUS: Record<RunStatus, 'input-available' | 'output-available' | 'output-error'> = {
  running: 'input-available',
  error: 'output-error',
  complete: 'output-available',
};

/**
 * Renders a tool-call run of any length (1 through N) through one
 * persistent component instance — never remounted as more calls join,
 * since the caller keys this by the run's stable `runKey`. A length-1 run
 * looks and behaves exactly like a standalone tool call (reusing
 * useToolCallDisplay so the two never drift); length 2+ shows the "Ran N
 * commands" summary with each call nested one level deeper via the
 * unmodified ToolCallRenderer. Always closed by default — only a manual
 * toggle opens it, never the run's running/error status.
 */
export const ToolRunGroup: React.FC<ToolRunGroupProps> = React.memo(function ToolRunGroup({ parts, runKey, getToolCallOpen, setToolCallOpen }) {
  const open = getToolCallOpen(runKey) ?? false;
  const isSolo = parts.length === 1;
  // Solo's toggle also seeds the row key it'll carry if a 2nd call joins
  // later — same identifier the parts.map below assigns at index 0 — so a
  // manually-expanded solo call is already expanded once it becomes that
  // nested row, instead of reverting to its own untouched default.
  const onOpenChange = (next: boolean) => {
    setToolCallOpen(runKey, next);
    if (isSolo) {
      setToolCallOpen(parts[0].toolCallId || `${parts[0].type}-0`, next);
    }
  };

  const status = useMemo(() => computeToolRunStatus(parts), [parts]);

  // Every part in a run dispatches 'generic' by construction — diff/task/
  // agent tools are filtered out of a run before it's ever built (see
  // isStandaloneTool in tool-significance.ts, whose SPECIAL_HANDLED_TOOLS
  // set matches dispatchToolCall's 'task'/'agent' classification exactly).
  const soloDispatch = useMemo(() => dispatchToolCall(parts[0], TASK_TOOL_NAMES), [parts]);
  const soloToolName = soloDispatch.kind === 'generic' ? soloDispatch.toolName : (parts[0].toolName || 'unknown_tool');
  const soloPart = soloDispatch.kind === 'generic' ? soloDispatch.part : parts[0];
  const solo = useToolCallDisplay(soloPart, soloToolName);

  const summary = useMemo(() => summarizeToolRun(parts, TOOL_NAME_MAP), [parts]);
  const title = isSolo ? solo.descriptiveTitle : summary;
  const headerType: `tool-${string}` = isSolo ? `tool-${soloToolName}` : 'tool-run-group';
  const headerState = isSolo ? solo.toolState : HEADER_STATE_FOR_STATUS[status];

  return (
    <Tool className="my-2" open={open} onOpenChange={onOpenChange}>
      <ToolHeader title={title} type={headerType} state={headerState} />
      <ToolContent>
        {isSolo ? (
          solo.richContent || renderToolFallbackContent(solo.state)
        ) : (
          // Children already carry their own `my-2` vertical margin (same as a
          // top-level ToolCallRenderer) — no extra space-y/padding here, just
          // the indent that marks them as nested inside the group.
          <div className="pl-2">
            {parts.map((part, i) => {
              // Same identifier for the React key and the persisted open-state
              // lookup, so the (rare) missing-toolCallId case degrades
              // consistently instead of colliding on '' in one but not the other.
              const rowKey = part.toolCallId || `${part.type}-${i}`;
              return (
                <ToolCallRenderer
                  key={rowKey}
                  part={part}
                  open={getToolCallOpen(rowKey)}
                  onOpenChange={(next) => setToolCallOpen(rowKey, next)}
                />
              );
            })}
          </div>
        )}
      </ToolContent>
    </Tool>
  );
});
