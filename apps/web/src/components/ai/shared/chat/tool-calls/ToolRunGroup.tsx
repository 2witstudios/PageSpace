import React, { useMemo } from 'react';
import { Tool, ToolContent, ToolHeader } from '@/components/ai/ui/tool';
import { ToolCallRenderer, TOOL_NAME_MAP } from './ToolCallRenderer';
import { getDisplayToolName, resolveEffectiveToolName } from './tool-significance';
import type { ProcessedToolPart } from '../message-types';

interface ToolRunGroupProps {
  parts: ProcessedToolPart[];
}

type AggregatedState = 'input-streaming' | 'input-available' | 'output-available' | 'output-error';

const toBucket = (state: ProcessedToolPart['state']): AggregatedState => {
  switch (state) {
    case 'input-streaming':
    case 'streaming':
      return 'input-streaming';
    case 'output-available':
    case 'done':
      return 'output-available';
    case 'output-error':
      return 'output-error';
    case 'input-available':
    default:
      return 'input-available';
  }
};

/**
 * Collapses a run of 2+ consecutive non-diff tool calls into one summary
 * card. Expanding it renders each original call exactly as it does today via
 * the unmodified ToolCallRenderer, just nested one level deeper.
 */
export const ToolRunGroup: React.FC<ToolRunGroupProps> = React.memo(function ToolRunGroup({ parts }) {
  const { aggregatedState, defaultOpen } = useMemo(() => {
    const buckets = parts.map(p => toBucket(p.state));
    if (buckets.some(b => b === 'output-error')) {
      return { aggregatedState: 'output-error' as const, defaultOpen: true };
    }
    if (buckets.some(b => b === 'input-streaming' || b === 'input-available')) {
      return { aggregatedState: 'input-available' as const, defaultOpen: true };
    }
    return { aggregatedState: 'output-available' as const, defaultOpen: false };
  }, [parts]);

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

  return (
    <Tool className="my-2" defaultOpen={defaultOpen}>
      <ToolHeader title={summary} type="tool-run-group" state={aggregatedState} />
      <ToolContent>
        <div className="space-y-1 py-1 pl-2">
          {parts.map((part) => (
            <ToolCallRenderer key={part.toolCallId || `${part.toolName}-${part.type}`} part={part} />
          ))}
        </div>
      </ToolContent>
    </Tool>
  );
});
