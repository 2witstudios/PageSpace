import React, { useMemo } from 'react';
import { Tool, ToolContent, ToolHeader } from '@/components/ai/ui/tool';
import { ToolCallRenderer, TOOL_NAME_MAP } from './ToolCallRenderer';
import { summarizeToolRun } from './tool-significance';
import { useAutoCollapseOnComplete, type RunStatus } from './useAutoCollapseOnComplete';
import type { ProcessedToolPart } from '../message-types';

interface ToolRunGroupProps {
  parts: ProcessedToolPart[];
  /**
   * Reads/writes a child's manually-toggled expand state, keyed by
   * toolCallId, from an ancestor that never remounts (MessageRenderer /
   * CompactMessageRenderer). Without this, a card's open/closed state would
   * reset whenever useGroupedParts retroactively folds a standalone call
   * into this group (a structural change that forces React to remount that
   * render slot).
   */
  getToolCallOpen: (toolCallId: string) => boolean | undefined;
  setToolCallOpen: (toolCallId: string, open: boolean) => void;
}

const toRunStatus = (state: ProcessedToolPart['state']): RunStatus => {
  switch (state) {
    case 'output-error':
      return 'error';
    case 'output-available':
    case 'done':
      return 'complete';
    default:
      return 'running';
  }
};

const computeRunStatus = (parts: ProcessedToolPart[]): RunStatus => {
  const statuses = parts.map(p => toRunStatus(p.state));
  if (statuses.includes('error')) return 'error';
  if (statuses.includes('running')) return 'running';
  return 'complete';
};

const HEADER_STATE_FOR_STATUS: Record<RunStatus, 'input-available' | 'output-available' | 'output-error'> = {
  running: 'input-available',
  error: 'output-error',
  complete: 'output-available',
};

/**
 * Collapses a run of 2+ consecutive non-diff tool calls into one summary
 * card. Expanding it renders each original call exactly as it does today via
 * the unmodified ToolCallRenderer, just nested one level deeper.
 */
export const ToolRunGroup: React.FC<ToolRunGroupProps> = React.memo(function ToolRunGroup({ parts, getToolCallOpen, setToolCallOpen }) {
  const status = useMemo(() => computeRunStatus(parts), [parts]);
  const { open, onOpenChange } = useAutoCollapseOnComplete(status);
  const summary = useMemo(() => summarizeToolRun(parts, TOOL_NAME_MAP), [parts]);

  return (
    <Tool className="my-2" open={open} onOpenChange={onOpenChange}>
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
    </Tool>
  );
});
