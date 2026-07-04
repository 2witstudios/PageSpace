import React, { useMemo } from 'react';
import { ChevronDown, ChevronRight, CheckCircle, AlertCircle, Loader2 } from 'lucide-react';
import { CompactToolCallRenderer, TOOL_NAME_MAP } from './CompactToolCallRenderer';
import { summarizeToolRun, computeToolRunStatus } from './tool-significance';
import { useAutoCollapseOnComplete } from './useAutoCollapseOnComplete';
import type { ProcessedToolPart } from '../message-types';

interface CompactToolRunGroupProps {
  parts: ProcessedToolPart[];
  /** See ToolRunGroup.tsx's identical props for why this is needed. */
  getToolCallOpen: (toolCallId: string) => boolean | undefined;
  setToolCallOpen: (toolCallId: string, open: boolean) => void;
}

/**
 * Compact sibling of ToolRunGroup for the sidebar AI assistant tab, which
 * uses a bespoke useState expand pattern rather than shadcn Collapsible.
 * Shares useAutoCollapseOnComplete with ToolRunGroup so both surfaces
 * auto-expand while running/erroring and auto-collapse once complete, but
 * respect a manual toggle afterward.
 */
export const CompactToolRunGroup: React.FC<CompactToolRunGroupProps> = React.memo(function CompactToolRunGroup({ parts, getToolCallOpen, setToolCallOpen }) {
  const status = useMemo(() => computeToolRunStatus(parts), [parts]);
  const { open: expanded, onOpenChange } = useAutoCollapseOnComplete(status);

  const summary = useMemo(() => summarizeToolRun(parts, TOOL_NAME_MAP), [parts]);

  const statusIcon = useMemo(() => {
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
        <span className="font-medium truncate flex-1 min-w-0" title={summary}>{summary}</span>
        <div className="flex-shrink-0">{statusIcon}</div>
      </button>

      {expanded && (
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
      )}
    </div>
  );
});
