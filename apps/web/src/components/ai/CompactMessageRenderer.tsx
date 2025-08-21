import React, { useMemo } from 'react';
import { UIMessage } from 'ai';
import { CompactToolCallRenderer } from './CompactToolCallRenderer';
import { MemoizedMarkdown } from './MemoizedMarkdown';

interface TextPart {
  type: 'text';
  text: string;
}

interface ToolPart {
  type: string; // "tool-{toolName}"
  toolCallId: string;
  toolName: string;
  input?: Record<string, unknown>;
  output?: unknown;
  state: 'input-streaming' | 'input-available' | 'output-available' | 'output-error';
}

interface TextGroupPart {
  type: 'text-group';
  parts: TextPart[];
}

interface ToolGroupPart {
  type: string; // "tool-{toolName}"
  toolCallId: string;
  toolName: string;
  input?: Record<string, unknown>;
  output?: unknown;
  state: 'input-streaming' | 'input-available' | 'output-available' | 'output-error' | 'done' | 'streaming';
}

type GroupedPart = TextGroupPart | ToolGroupPart;

interface CompactTextBlockProps {
  parts: TextPart[];
  role: 'user' | 'assistant' | 'system';
  messageId: string;
  createdAt?: Date;
}

/**
 * Compact text block for sidebar - minimal margins and padding
 */
const CompactTextBlock: React.FC<CompactTextBlockProps> = ({ parts, role, messageId, createdAt }) => {
  const content = parts.map(part => part.text).join('');
  
  if (!content.trim()) return null;
  
  return (
    <div
      className={`p-2 rounded-md text-xs ${
        role === 'user' 
          ? 'bg-blue-50 dark:bg-blue-900/20 ml-2' 
          : 'bg-gray-50 dark:bg-gray-800/50'
      }`}
    >
      <div className={`text-xs font-medium mb-0.5 ${
        role === 'user' ? 'text-blue-700 dark:text-blue-300' : 'text-gray-700 dark:text-gray-300'
      }`}>
        {role === 'user' ? 'You' : 'AI'}
      </div>
      <div className="text-gray-900 dark:text-gray-100 prose prose-xs dark:prose-invert max-w-full overflow-hidden">
        <div className="break-words overflow-wrap-anywhere">
          <MemoizedMarkdown content={content} id={`${messageId}-text`} />
        </div>
      </div>
      {createdAt && (
        <div className="text-[10px] text-gray-500 mt-1">
          {new Date(createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </div>
      )}
    </div>
  );
};

interface CompactMessageRendererProps {
  message: UIMessage;
}

/**
 * Compact message renderer for sidebar - optimized for narrow width
 */
export const CompactMessageRenderer: React.FC<CompactMessageRendererProps> = ({ message }) => {
  const groupedParts = useMemo(() => {
    if (!message.parts || message.parts.length === 0) {
      return [];
    }

    const groups: GroupedPart[] = [];
    let currentTextGroup: TextPart[] = [];

    message.parts.forEach((part) => {
      if (part.type === 'text') {
        currentTextGroup.push(part as TextPart);
      } else if (part.type.startsWith('tool-')) {
        // If we have accumulated text parts, add them as a group
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
        
        // Ensure state is one of the valid values with proper type checking
        const validStates = ['input-streaming', 'input-available', 'output-available', 'output-error', 'done', 'streaming'] as const;
        type ValidState = typeof validStates[number];
        const isValidState = (value: unknown): value is ValidState => {
          return typeof value === 'string' && (validStates as readonly string[]).includes(value);
        };
        const state: ValidState = isValidState(toolPart.state) ? toolPart.state : 'input-available';
        
        // Add the tool part
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
  }, [message.parts]);

  const createdAt = (message as { createdAt?: Date }).createdAt;

  return (
    <div key={message.id} className="mb-2">
      {groupedParts.map((group, index) => {
        if (group.type === 'text-group') {
          // Type narrowing: we know this is a TextGroupPart
          const textGroup = group as TextGroupPart;
          return (
            <CompactTextBlock
              key={`${message.id}-text-${index}`}
              parts={textGroup.parts}
              role={message.role as 'user' | 'assistant' | 'system'}
              messageId={message.id}
              createdAt={index === groupedParts.length - 1 ? createdAt : undefined} // Only show timestamp on last part
            />
          );
        } else if (group.type.startsWith('tool-')) {
          // Type narrowing: we know this is a ToolGroupPart
          const toolGroup = group as ToolGroupPart;
          return (
            <div key={`${message.id}-tool-${index}`} className="mt-1">
              <CompactToolCallRenderer 
                part={{
                  type: toolGroup.type,
                  toolName: toolGroup.toolName,
                  toolCallId: toolGroup.toolCallId,
                  input: toolGroup.input,
                  output: toolGroup.output,
                  state: toolGroup.state,
                }}
              />
            </div>
          );
        }
        return null;
      })}
    </div>
  );
};