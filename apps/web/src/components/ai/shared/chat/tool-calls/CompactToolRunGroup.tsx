import React, { useMemo } from 'react';
import { ChevronDown, ChevronRight, CheckCircle, AlertCircle, Loader2 } from 'lucide-react';
import { CompactToolCallRenderer, TOOL_NAME_MAP } from './CompactToolCallRenderer';
import { summarizeToolRun } from './tool-significance';
import { useAutoCollapseOnComplete, type RunStatus } from './useAutoCollapseOnComplete';
import type { ProcessedToolPart } from '../message-types';

interface CompactToolRunGroupProps {
  parts: ProcessedToolPart[];
}

const toStatus = (state: ProcessedToolPart['state']): RunStatus => {
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

const computeStatus = (parts: ProcessedToolPart[]): RunStatus => {
  const statuses = parts.map(p => toStatus(p.state));
  if (statuses.includes('error')) return 'error';
  if (statuses.includes('running')) return 'running';
  return 'complete';
};

/**
 * Compact sibling of ToolRunGroup for the sidebar AI assistant tab, which
 * uses a bespoke useState expand pattern rather than shadcn Collapsible.
 * Shares useAutoCollapseOnComplete with ToolRunGroup so both surfaces
 * auto-expand while running/erroring and auto-collapse once complete, but
 * respect a manual toggle afterward.
 */
export const CompactToolRunGroup: React.FC<CompactToolRunGroupProps> = React.memo(function CompactToolRunGroup({ parts }) {
  const status = useMemo(() => computeStatus(parts), [parts]);
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
        onClick={() => onOpenChange(!expanded)}
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
          {parts.map((part, i) => (
            <CompactToolCallRenderer key={part.toolCallId || `${part.type}-${i}`} part={part} />
          ))}
        </div>
      )}
    </div>
  );
});
