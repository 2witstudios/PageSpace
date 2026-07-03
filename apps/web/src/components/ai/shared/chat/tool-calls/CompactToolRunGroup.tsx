import React, { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, CheckCircle, AlertCircle, Loader2 } from 'lucide-react';
import { CompactToolCallRenderer, TOOL_NAME_MAP } from './CompactToolCallRenderer';
import { getDisplayToolName, resolveEffectiveToolName } from './tool-significance';
import type { ProcessedToolPart } from '../message-types';

interface CompactToolRunGroupProps {
  parts: ProcessedToolPart[];
}

type Status = 'running' | 'error' | 'complete';

const toStatus = (state: ProcessedToolPart['state']): Status => {
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

const computeStatus = (parts: ProcessedToolPart[]): Status => {
  const statuses = parts.map(p => toStatus(p.state));
  if (statuses.includes('error')) return 'error';
  if (statuses.includes('running')) return 'running';
  return 'complete';
};

/**
 * Compact sibling of ToolRunGroup for the sidebar AI assistant tab, which
 * uses a bespoke useState expand pattern rather than shadcn Collapsible.
 * `isExpanded`'s initial value auto-expands while running/errored (mirroring
 * PageAgentConversationRenderer's defaultOpen precedent); once mounted it's
 * fully user-controlled, same uncontrolled-after-mount semantics as
 * Collapsible's defaultOpen.
 */
export const CompactToolRunGroup: React.FC<CompactToolRunGroupProps> = React.memo(function CompactToolRunGroup({ parts }) {
  const [expanded, setExpanded] = useState(() => computeStatus(parts) !== 'complete');

  const status = useMemo(() => computeStatus(parts), [parts]);

  const summary = useMemo(() => {
    const counts = new Map<string, number>();
    for (const part of parts) {
      const effectiveName = resolveEffectiveToolName(part.toolName, part.input);
      counts.set(effectiveName, (counts.get(effectiveName) ?? 0) + 1);
    }
    const breakdown = Array.from(counts.entries())
      .map(([name, count]) => `${getDisplayToolName(name, TOOL_NAME_MAP)} ×${count}`)
      .join(', ');
    return `Ran ${parts.length} commands (${breakdown})`;
  }, [parts]);

  const statusIcon = useMemo(() => {
    const iconClass = 'h-3 w-3';
    if (status === 'error') return <AlertCircle className={`${iconClass} text-red-500`} />;
    if (status === 'running') return <Loader2 className={`${iconClass} text-primary animate-spin`} />;
    return <CheckCircle className={`${iconClass} text-green-500`} />;
  }, [status]);

  return (
    <div className="py-0.5 text-[11px] max-w-full">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center space-x-1.5 text-left hover:bg-muted/30 rounded py-0.5 px-1 transition-colors max-w-full"
      >
        {expanded ? <ChevronDown className="h-3 w-3 flex-shrink-0" /> : <ChevronRight className="h-3 w-3 flex-shrink-0" />}
        <span className="font-medium truncate flex-1 min-w-0" title={summary}>{summary}</span>
        <div className="flex-shrink-0">{statusIcon}</div>
      </button>

      {expanded && (
        <div className="mt-1 max-w-full break-words pl-2 space-y-0.5">
          {parts.map((part) => (
            <CompactToolCallRenderer key={part.toolCallId || `${part.toolName}-${part.type}`} part={part} />
          ))}
        </div>
      )}
    </div>
  );
});
