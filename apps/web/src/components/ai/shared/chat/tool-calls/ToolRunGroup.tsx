import React, { useMemo } from 'react';
import { Tool, ToolContent, ToolHeader } from '@/components/ai/ui/tool';
import { ToolCallRenderer, TOOL_NAME_MAP, useToolCallDisplay, renderToolFallbackContent } from './ToolCallRenderer';
import { summarizeToolRun, type RunStatus } from './tool-significance';
import { useToolRun } from './useToolRun';
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
 * Renders a length-1 run exactly like a standalone tool call. Split into its
 * own component (rather than inlined behind a ternary in ToolRunGroup) so
 * useToolCallDisplay's real work — JSON-parsing input/output and building
 * richContent via the tool-renderer registry — only ever runs when this run
 * genuinely is solo; a 2+-call run never mounts this component at all, so
 * that work is never done and discarded.
 */
const SoloRunBody: React.FC<{ part: ProcessedToolPart; toolName: string }> = React.memo(function SoloRunBody({ part, toolName }) {
  const { state, toolState, descriptiveTitle, richContent } = useToolCallDisplay(part, toolName);
  return (
    <>
      <ToolHeader title={descriptiveTitle} type={`tool-${toolName}`} state={toolState} />
      <ToolContent>{richContent || renderToolFallbackContent(state)}</ToolContent>
    </>
  );
});

/**
 * Renders the "Ran N commands" summary header plus each call nested one
 * level deeper via the unmodified ToolCallRenderer. Only mounted for 2+-call
 * runs, symmetric with SoloRunBody above.
 */
const GroupRunBody: React.FC<{
  parts: ProcessedToolPart[];
  status: RunStatus;
  getToolCallOpen: (key: string) => boolean | undefined;
  setToolCallOpen: (key: string, open: boolean) => void;
}> = React.memo(function GroupRunBody({ parts, status, getToolCallOpen, setToolCallOpen }) {
  const summary = useMemo(() => summarizeToolRun(parts, TOOL_NAME_MAP), [parts]);

  return (
    <>
      <ToolHeader title={summary} type="tool-run-group" state={HEADER_STATE_FOR_STATUS[status]} />
      <ToolContent>
        {/* Children already carry their own `my-2` vertical margin (same as a
            top-level ToolCallRenderer) — no extra space-y/padding here, just
            the indent that marks them as nested inside the group. */}
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
      </ToolContent>
    </>
  );
});

/**
 * Renders a tool-call run of any length (1 through N) through one
 * persistent component instance — never remounted as more calls join,
 * since the caller keys this by the run's stable `runKey`. Always closed by
 * default — only a manual toggle opens it, never the run's running/error
 * status.
 */
export const ToolRunGroup: React.FC<ToolRunGroupProps> = React.memo(function ToolRunGroup({ parts, runKey, getToolCallOpen, setToolCallOpen }) {
  const { isSolo, open, onOpenChange, status, soloToolName, soloPart } = useToolRun(parts, runKey, getToolCallOpen, setToolCallOpen);

  return (
    <Tool className="my-2" open={open} onOpenChange={onOpenChange}>
      {isSolo ? (
        <SoloRunBody part={soloPart} toolName={soloToolName} />
      ) : (
        <GroupRunBody parts={parts} status={status} getToolCallOpen={getToolCallOpen} setToolCallOpen={setToolCallOpen} />
      )}
    </Tool>
  );
});
