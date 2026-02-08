/**
 * Hook for grouping message parts for rendering.
 * Shared between MessageRenderer and CompactMessageRenderer.
 */

import { useMemo } from 'react';
import type { UIMessage } from 'ai';
import type { TextPart, FilePart, ToolPart, GroupedPart } from './message-types';
import { isValidToolState } from './message-types';

/**
 * Groups message parts for rendering.
 * - Consecutive text parts are grouped together
 * - Consecutive file parts are grouped together
 * - Each tool call is rendered individually (no grouping)
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

    parts.forEach((part) => {
      // Skip step-start and reasoning parts
      if (part.type === 'step-start' || part.type === 'reasoning') {
        return;
      }

      if (part.type === 'text') {
        flushFileGroup();
        currentTextGroup.push(part as TextPart);
      } else if (part.type === 'file') {
        flushTextGroup();
        const filePart = part as FilePart & Record<string, unknown>;
        currentFileGroup.push({
          type: 'file',
          url: typeof filePart.url === 'string' ? filePart.url : '',
          mediaType: typeof filePart.mediaType === 'string' ? filePart.mediaType : undefined,
          filename: typeof filePart.filename === 'string' ? filePart.filename : undefined,
        });
      } else if (part.type.startsWith('tool-')) {
        flushTextGroup();
        flushFileGroup();

        // Type guard and safe property access for tool parts
        const toolPart = part as ToolPart & Record<string, unknown>;
        const toolCallId = typeof toolPart.toolCallId === 'string' ? toolPart.toolCallId : '';
        const toolName = typeof toolPart.toolName === 'string' ? toolPart.toolName : part.type.replace('tool-', '');
        const state = isValidToolState(toolPart.state) ? toolPart.state : 'input-available';

        // Add each tool individually (no grouping)
        groups.push({
          type: part.type,
          toolCallId,
          toolName,
          input: toolPart.input,
          output: toolPart.output,
          state,
        });
      }
    });

    // Flush any remaining groups
    flushTextGroup();
    flushFileGroup();

    return groups;
  }, [parts]);
}
