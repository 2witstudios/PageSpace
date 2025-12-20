/**
 * Hook for grouping message parts for rendering.
 * Shared between MessageRenderer and CompactMessageRenderer.
 */

import { useMemo } from 'react';
import type { UIMessage } from 'ai';
import type { TextPart, ToolPart, GroupedPart } from './message-types';
import { isValidToolState } from './message-types';

/**
 * Groups message parts for rendering.
 * - Consecutive text parts are grouped together
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

    parts.forEach((part) => {
      // Skip step-start and reasoning parts
      if (part.type === 'step-start' || part.type === 'reasoning') {
        return;
      }

      if (part.type === 'text') {
        currentTextGroup.push(part as TextPart);
      } else if (part.type.startsWith('tool-')) {
        // If we have accumulated text parts, add them as a group first
        if (currentTextGroup.length > 0) {
          groups.push({
            type: 'text-group',
            parts: currentTextGroup
          });
          currentTextGroup = [];
        }

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

    // Add any remaining text parts
    if (currentTextGroup.length > 0) {
      groups.push({
        type: 'text-group',
        parts: currentTextGroup
      });
    }

    return groups;
  }, [parts]);
}
