import React, { useMemo } from 'react';
import { ChevronDown, ChevronRight, CheckCircle, AlertCircle, Loader2 } from 'lucide-react';
import { CompactToolCallRenderer, TOOL_NAME_MAP, useCompactToolCallDisplay } from './CompactToolCallRenderer';
import { summarizeToolRun, type RunStatus } from './tool-significance';
import { useToolRun } from './useToolRun';
import type { ProcessedToolPart } from '../message-types';

/**
 * Renders a length-1 run exactly like a standalone row (button + expanded
 * details below it). Split into its own component (rather than inlined
 * behind a ternary in CompactToolRunGroup) so useCompactToolCallDisplay's
 * real work — JSON-parsing input/output and building expandedDetails via
 * the tool-renderer registry — only ever runs when this run genuinely is
 * solo; a 2+-call run never mounts this component, so that work is never
 * done and discarded. Mirrors ToolRunGroup.tsx's SoloRunBody.
 */
const SoloRunBody: React.FC<{ part: ProcessedToolPart; toolName: string; expanded: boolean; onToggle: () => void }> = React.memo(function SoloRunBody({ part, toolName, expanded, onToggle }) {
  const { toolIcon, statusIcon, descriptiveTitle, compactSummary, expandedDetails } = useCompactToolCallDisplay(part, toolName, expanded);
  return (
    <>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="w-full flex items-center space-x-1.5 text-left hover:bg-muted/30 rounded py-0.5 px-1 transition-colors max-w-full"
      >
        {expanded ? <ChevronDown className="h-3 w-3 flex-shrink-0" /> : <ChevronRight className="h-3 w-3 flex-shrink-0" />}
        <div className="flex-shrink-0">{toolIcon}</div>
        <span className="font-medium truncate flex-1 min-w-0" title={descriptiveTitle}>{descriptiveTitle}</span>
        <div className="flex-shrink-0">{statusIcon}</div>
        <span className="text-gray-500 dark:text-gray-400 truncate max-w-[80px] min-w-0">{compactSummary}</span>
      </button>
      {expandedDetails}
    </>
  );
});

/**
 * Renders the "Ran N commands" summary row plus each call nested one level
 * deeper via the unmodified CompactToolCallRenderer. Only mounted for
 * 2+-call runs, symmetric with SoloRunBody above.
 */
const GroupRunBody: React.FC<{
  parts: ProcessedToolPart[];
  status: RunStatus;
  expanded: boolean;
  onToggle: () => void;
  getToolCallOpen: (key: string) => boolean | undefined;
  setToolCallOpen: (key: string, open: boolean) => void;
}> = React.memo(function GroupRunBody({ parts, status, expanded, onToggle, getToolCallOpen, setToolCallOpen }) {
  const summary = useMemo(() => summarizeToolRun(parts, TOOL_NAME_MAP), [parts]);

  const statusIcon = useMemo(() => {
    const iconClass = 'h-3 w-3';
    if (status === 'error') return <AlertCircle className={`${iconClass} text-red-500`} />;
    if (status === 'running') return <Loader2 className={`${iconClass} text-primary animate-spin`} />;
    return <CheckCircle className={`${iconClass} text-green-500`} />;
  }, [status]);

  return (
    <>
      <button
        type="button"
        onClick={onToggle}
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
    </>
  );
});

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
  const { isSolo, open: expanded, onOpenChange, status, soloToolName, soloPart } = useToolRun(parts, runKey, getToolCallOpen, setToolCallOpen);
  const onToggle = () => onOpenChange(!expanded);

  return (
    <div className="py-0.5 text-[11px] max-w-full">
      {isSolo ? (
        <SoloRunBody part={soloPart} toolName={soloToolName} expanded={expanded} onToggle={onToggle} />
      ) : (
        <GroupRunBody
          parts={parts}
          status={status}
          expanded={expanded}
          onToggle={onToggle}
          getToolCallOpen={getToolCallOpen}
          setToolCallOpen={setToolCallOpen}
        />
      )}
    </div>
  );
});
