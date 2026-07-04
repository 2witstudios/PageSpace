/**
 * Hook for grouping message parts for rendering.
 * Shared between MessageRenderer and CompactMessageRenderer.
 */

import { useMemo } from 'react';
import type { UIMessage } from 'ai';
import type { TextPart, FilePart, ToolPart, ProcessedToolPart, GroupedPart } from './message-types';
import { isValidToolState } from './message-types';
import { FINISH_TOOL_NAME } from '@/lib/ai/tools/finish-tool';
import { isStandaloneTool, isHiddenTool, resolveEffectiveToolName } from './tool-calls/tool-significance';

/**
 * Groups message parts for rendering.
 * - Consecutive text parts are grouped together
 * - Consecutive file parts are grouped together
 * - Runs of 2+ consecutive non-standalone tool calls are grouped into one
 *   ToolRunGroupPart; a lone call renders as before; standalone tools (diff-
 *   producing edits, task tools, ask_agent — see
 *   tool-calls/tool-significance.ts) always stand alone, breaking any run
 * - Skips step-start and reasoning parts
 */
export function useGroupedParts(parts: UIMessage['parts'] | undefined): GroupedPart[] {
  return useMemo(() => {
    if (!parts || parts.length === 0) {
      return [];
    }

    const groups: GroupedPart[] = [];
    let currentTextGroup: TextPart[] = [];
    let currentFileGroup: FilePart[] = [];
    let currentToolRun: ProcessedToolPart[] = [];

    const flushTextGroup = () => {
      if (currentTextGroup.length > 0) {
        groups.push({ type: 'text-group', parts: currentTextGroup });
        currentTextGroup = [];
      }
    };

    const flushFileGroup = () => {
      if (currentFileGroup.length > 0) {
        groups.push({ type: 'file-group', parts: currentFileGroup });
        currentFileGroup = [];
      }
    };

    const flushToolRun = () => {
      if (currentToolRun.length >= 2) {
        groups.push({ type: 'tool-run-group', parts: currentToolRun });
      } else if (currentToolRun.length === 1) {
        groups.push(currentToolRun[0]);
      }
      currentToolRun = [];
    };

    parts.forEach((part) => {
      // Skip step-start and reasoning parts
      if (part.type === 'step-start' || part.type === 'reasoning') {
        return;
      }

      if (part.type === 'text') {
        flushFileGroup();
        flushToolRun();
        currentTextGroup.push(part as TextPart);
      } else if (part.type === 'data-command-execution') {
        // Universal Commands execution indicator (UX spec §7) — rendered
        // standalone, above the content it precedes.
        flushTextGroup();
        flushFileGroup();
        flushToolRun();
        const dataPart = part as { type: 'data-command-execution'; id?: string; data?: unknown };
        groups.push({ type: 'data-command-execution', id: dataPart.id, data: dataPart.data });
      } else if (part.type === 'file') {
        flushTextGroup();
        flushToolRun();
        const filePart = part as FilePart & Record<string, unknown>;
        currentFileGroup.push({
          type: 'file',
          url: typeof filePart.url === 'string' ? filePart.url : '',
          mediaType: typeof filePart.mediaType === 'string' ? filePart.mediaType : undefined,
          filename: typeof filePart.filename === 'string' ? filePart.filename : undefined,
        });
      } else if (part.type.startsWith('tool-')) {
        // Type guard and safe property access for tool parts
        const toolPart = part as ToolPart & Record<string, unknown>;
        const toolCallId = typeof toolPart.toolCallId === 'string' ? toolPart.toolCallId : '';
        const toolName = typeof toolPart.toolName === 'string' ? toolPart.toolName : part.type.replace('tool-', '');

        // Skip internal control-flow tools (finish tool is not visible to users)
        if (toolName === FINISH_TOOL_NAME) {
          return;
        }

        const effectiveToolName = resolveEffectiveToolName(toolName, toolPart.input);

        // Skip hidden tool-discovery calls (tool_search, including when
        // wrapped in execute_tool) the same way — ToolCallRenderer/
        // CompactToolCallRenderer already render these as invisible, so they
        // must never become a phantom entry in a run's count or summary.
        if (isHiddenTool(toolName) || isHiddenTool(effectiveToolName)) {
          return;
        }

        flushTextGroup();
        flushFileGroup();

        const state = isValidToolState(toolPart.state) ? toolPart.state : 'input-available';
        const processedPart: ProcessedToolPart = {
          type: part.type,
          toolCallId,
          toolName,
          input: toolPart.input,
          output: toolPart.output,
          state,
        };

        if (isStandaloneTool(effectiveToolName)) {
          // Diff-producing edits and SPECIAL_HANDLED_TOOLS (tasks, ask_agent)
          // always stand alone, breaking any run.
          flushToolRun();
          groups.push(processedPart);
        } else {
          currentToolRun.push(processedPart);
        }
      }
    });

    // Flush any remaining groups
    flushTextGroup();
    flushFileGroup();
    flushToolRun();

    return groups;
  }, [parts]);
}
