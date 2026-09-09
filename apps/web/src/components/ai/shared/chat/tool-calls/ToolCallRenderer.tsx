import React, { memo, useMemo } from 'react';

import {
  Tool,
  ToolContent,
  ToolHeader,
} from '@/components/ai/ui/tool';
import { PageAgentConversationRenderer } from '@/components/ai/page-agents';
import { AskUserQuestionCard } from '../ask-user/AskUserQuestionCard';
import { TaskRenderer } from './TaskRenderer';
import { GeneratedImageRenderer } from './GeneratedImageRenderer';
import { TASK_TOOL_NAMES } from '../useAggregatedTasks';
import { renderToolContent } from './registry';
import { dispatchToolCall, resolveIntegrationToolLabel } from './tool-call-dispatch';
import { TOOL_NAME_MAP, describeToolCall, formatToolName } from '@/lib/ai/tools/tool-labels';

// Re-exported from its new home so existing importers keep working. The table
// moved to `lib/` because the voice reducer needs the same words and cannot
// import from `components/`.
export { TOOL_NAME_MAP };

export interface ToolPart {
  type: string;
  toolName?: string;
  toolCallId?: string;
  state?: 'input-streaming' | 'input-available' | 'output-available' | 'output-error' | 'done' | 'streaming';
  input?: unknown;
  output?: unknown;
  errorText?: string;
}

interface ToolCallRendererProps {
  part: ToolPart;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

// Helper for safe JSON parsing
const safeJsonParse = (value: unknown): Record<string, unknown> | null => {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return { raw: value };
    }
  }
  if (typeof value === 'object' && value !== null) {
    return value as Record<string, unknown>;
  }
  return null;
};

/**
 * Fallback body shown when the tool renderer registry has nothing rich for
 * this tool — shared by ToolCallRendererInternal and ToolRunGroup's
 * length-1 (solo) branch so the two never drift.
 */
export function renderToolFallbackContent(state: string): React.ReactNode {
  return (
    <div className="px-3 py-2 text-sm text-muted-foreground">
      {state === 'input-streaming' || state === 'streaming' ? (
        'Processing...'
      ) : state === 'input-available' ? (
        'Waiting for result...'
      ) : (
        'Completed'
      )}
    </div>
  );
}

/**
 * Computes everything ToolCallRendererInternal needs to render a tool
 * call's title/state/content, extracted so ToolRunGroup can render a
 * length-1 run identically to a standalone card without duplicating this
 * logic.
 */
export function useToolCallDisplay(part: ToolPart, toolName: string) {
  const state = part.state || 'input-available';
  const input = part.input;
  const output = part.output;
  const error = part.errorText;

  // Map state to ToolHeader valid states
  const toolState = useMemo((): "input-streaming" | "input-available" | "output-available" | "output-error" => {
    switch (state) {
      case 'input-streaming': return 'input-streaming';
      case 'input-available': return 'input-available';
      case 'output-available': return 'output-available';
      case 'output-error': return 'output-error';
      case 'done': return 'output-available';
      case 'streaming': return 'input-streaming';
      default: return 'input-available';
    }
  }, [state]);

  // Memoize parsed input/output using consistent parsing
  const parsedInput = useMemo(() => safeJsonParse(input), [input]);
  const parsedOutput = useMemo(() => {
    // Use strict null/undefined check to preserve valid falsy values (0, false, "")
    if (output == null) return null;
    return safeJsonParse(output);
  }, [output]);

  // Memoize formatted tool name. The integration override stays here: it is the
  // one part that depends on the integrations registry, which `lib/ai/tools/
  // tool-labels.ts` deliberately does not.
  const formattedToolName = useMemo(
    () => resolveIntegrationToolLabel(toolName) || formatToolName(toolName),
    [toolName],
  );

  // Memoize descriptive title
  const descriptiveTitle = useMemo(
    () => describeToolCall(toolName, parsedInput, formattedToolName),
    [toolName, parsedInput, formattedToolName],
  );

  // Build rich content via the tool renderer registry
  const richContent = useMemo(
    () => renderToolContent({ toolName, parsedInput, parsedOutput, output, error }),
    [toolName, parsedInput, parsedOutput, output, error]
  );

  return { state, toolState, descriptiveTitle, richContent };
}

// Internal renderer component with hooks
const ToolCallRendererInternal: React.FC<{ part: ToolPart; toolName: string; open?: boolean; onOpenChange?: (open: boolean) => void }> = memo(function ToolCallRendererInternal({ part, toolName, open, onOpenChange }) {
  const { state, toolState, descriptiveTitle, richContent } = useToolCallDisplay(part, toolName);

  // Render with rich content (no Parameters/Result wrappers)
  // Only pass open/onOpenChange (making the Collapsible controlled) when a
  // caller actually provides onOpenChange — otherwise Radix's
  // useControllableState would see `open` flip from undefined to a boolean
  // the first time an ancestor records a manual toggle, logging an
  // uncontrolled-to-controlled warning even though nothing is visibly wrong.
  // Deciding controlled-ness once, up front, based on onOpenChange's
  // presence (rather than open's value) means a given mounted instance never
  // changes modes across its lifetime.
  const collapsibleProps = onOpenChange ? { open: open ?? false, onOpenChange } : {};

  return (
    <Tool className="my-2" {...collapsibleProps}>
      <ToolHeader
        title={descriptiveTitle}
        type={`tool-${toolName}`}
        state={toolState}
      />
      <ToolContent>
        {richContent || renderToolFallbackContent(state)}
      </ToolContent>
    </Tool>
  );
});

export const ToolCallRenderer: React.FC<ToolCallRendererProps> = memo(function ToolCallRenderer({ part, open, onOpenChange }) {
  const dispatch = dispatchToolCall(part, TASK_TOOL_NAMES);

  switch (dispatch.kind) {
    case 'hidden':
      return null;
    case 'task':
      return <TaskRenderer part={dispatch.part} />;
    case 'agent':
      return <PageAgentConversationRenderer part={dispatch.part} />;
    case 'question':
      return <AskUserQuestionCard part={dispatch.part} />;
    case 'image':
      return <GeneratedImageRenderer part={dispatch.part} />;
    case 'generic':
      return <ToolCallRendererInternal part={dispatch.part} toolName={dispatch.toolName} open={open} onOpenChange={onOpenChange} />;
  }
});
