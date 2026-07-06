import React, { useMemo } from 'react';
import { ChevronDown, ChevronRight, CheckCircle, AlertCircle, Loader2 } from 'lucide-react';
import { CompactToolCallRenderer, TOOL_NAME_MAP, useCompactToolCallDisplay } from './CompactToolCallRenderer';
import { dispatchToolCall } from './tool-call-dispatch';
import { TASK_TOOL_NAMES } from '../useAggregatedTasks';
import { summarizeToolRun, computeToolRunStatus } from './tool-significance';
import type { ProcessedToolPart } from '../message-types';

interface CompactToolRunGroupProps {
  /** Always 1+. A length-1 run renders identically to a standalone row. */
  parts: ProcessedToolPart[];
  /** Stable across the run's growth — see message-types.ts's ToolRunGroupPart. */
  runKey: string;
  /** See ToolRunGroup.tsx's identical props for why this is needed. */
  getToolCallOpen: (key: string) => boolean | undefined;
  setToolCallOpen: (key: string, open: boolean) => void;
}

/**
 * Compact sibling of ToolRunGroup for the sidebar AI assistant tab, which
 * uses a bespoke button/div expand pattern rather than shadcn Collapsible.
 * Same design: one persistent component instance across a run's growth,
 * closed by default, no auto-expand from running/error status.
 */
export const CompactToolRunGroup: React.FC<CompactToolRunGroupProps> = React.memo(function CompactToolRunGroup({ parts, runKey, getToolCallOpen, setToolCallOpen }) {
  const expanded = getToolCallOpen(runKey) ?? false;
  const isSolo = parts.length === 1;
  // See the identical note in ToolRunGroup.tsx: also seed the row key a
  // solo call will carry once a 2nd call joins, so a manual expand survives
  // the transition into a nested row.
  const onOpenChange = (next: boolean) => {
    setToolCallOpen(runKey, next);
    if (isSolo) {
      setToolCallOpen(parts[0].toolCallId || `${parts[0].type}-0`, next);
    }
  };

  const status = useMemo(() => computeToolRunStatus(parts), [parts]);

  // Every part in a run dispatches 'generic' by construction — see the
  // identical note in ToolRunGroup.tsx.
  const soloDispatch = useMemo(() => dispatchToolCall(parts[0], TASK_TOOL_NAMES), [parts]);
  const soloToolName = soloDispatch.kind === 'generic' ? soloDispatch.toolName : (parts[0].toolName || 'unknown_tool');
  const soloPart = soloDispatch.kind === 'generic' ? soloDispatch.part : parts[0];
  const solo = useCompactToolCallDisplay(soloPart, soloToolName, expanded);

  const summary = useMemo(() => summarizeToolRun(parts, TOOL_NAME_MAP), [parts]);
  const title = isSolo ? solo.descriptiveTitle : summary;

  const groupStatusIcon = useMemo(() => {
    const iconClass = 'h-3 w-3';
    if (status === 'error') return <AlertCircle className={`${iconClass} text-red-500`} />;
    if (status === 'running') return <Loader2 className={`${iconClass} text-primary animate-spin`} />;
    return <CheckCircle className={`${iconClass} text-green-500`} />;
  }, [status]);

  return (
    <div className="py-0.5 text-[11px] max-w-full">
      <button
        type="button"
        onClick={() => onOpenChange(!expanded)}
        aria-expanded={expanded}
        className="w-full flex items-center space-x-1.5 text-left hover:bg-muted/30 rounded py-0.5 px-1 transition-colors max-w-full"
      >
        {expanded ? <ChevronDown className="h-3 w-3 flex-shrink-0" /> : <ChevronRight className="h-3 w-3 flex-shrink-0" />}
        {isSolo && <div className="flex-shrink-0">{solo.toolIcon}</div>}
        <span className="font-medium truncate flex-1 min-w-0" title={title}>{title}</span>
        <div className="flex-shrink-0">{isSolo ? solo.statusIcon : groupStatusIcon}</div>
        {isSolo && (
          <span className="text-gray-500 dark:text-gray-400 truncate max-w-[80px] min-w-0">
            {solo.compactSummary}
          </span>
        )}
      </button>

      {isSolo ? solo.expandedDetails : (expanded && (
        // pl-1 (not pl-2): the sidebar is already tight (max-w-[80px]
        // truncating summary column on each nested row), so keep the nesting
        // indent minimal to avoid tripping truncation sooner than necessary.
        <div className="mt-1 max-w-full break-words pl-1 space-y-0.5">
          {parts.map((part, i) => {
            const rowKey = part.toolCallId || `${part.type}-${i}`;
            return (
              <CompactToolCallRenderer
                key={rowKey}
                part={part}
                expanded={getToolCallOpen(rowKey)}
                onExpandedChange={(next) => setToolCallOpen(rowKey, next)}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
});
