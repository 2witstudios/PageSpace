import React, { useMemo } from 'react';
import { UIMessage } from 'ai';
import { ToolCallRenderer } from './ToolCallRenderer';
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

interface TextBlockProps {
  parts: TextPart[];
  role: 'user' | 'assistant' | 'system';
  messageId: string;
  createdAt?: Date;
}

/**
 * Renders a group of consecutive text parts as a single block
 */
const TextBlock: React.FC<TextBlockProps> = React.memo(({ parts, role, messageId, createdAt }) => {
  const content = parts.map(part => part.text).join('');
  
  if (!content.trim()) return null;
  
  return (
    <div
      className={`p-3 rounded-lg mb-2 ${
        role === 'user' 
          ? 'bg-blue-50 dark:bg-blue-900/20 ml-8' 
          : 'bg-gray-50 dark:bg-gray-800/50 mr-8'
      }`}
    >
      <div className={`text-sm font-medium mb-1 ${
        role === 'user' ? 'text-blue-700 dark:text-blue-300' : 'text-gray-700 dark:text-gray-300'
      }`}>
        {role === 'user' ? 'You' : 'Assistant'}
      </div>
      <div className="text-gray-900 dark:text-gray-100 prose prose-sm dark:prose-invert max-w-none prose-pre:bg-gray-100 dark:prose-pre:bg-gray-800">
        <MemoizedMarkdown content={content} id={`${messageId}-text`} />
      </div>
      {createdAt && (
        <div className="text-xs text-gray-500 mt-2">
          {new Date(createdAt).toLocaleTimeString()}
        </div>
      )}
    </div>
  );
});

TextBlock.displayName = 'TextBlock';

interface MessageRendererProps {
  message: UIMessage;
}

/**
 * Renders a UIMessage with parts in chronological order
 * Groups consecutive text parts together while preserving tool call positions
 */
export const MessageRenderer: React.FC<MessageRendererProps> = React.memo(({ message }) => {
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
  }, [message.parts]); // Remove message.id as it's not needed for memoization

  const createdAt = (message as { createdAt?: Date }).createdAt;

  return (
    <div key={message.id} className="mb-4">
      {groupedParts.map((group, index) => {
        if (group.type === 'text-group') {
          // Type narrowing: we know this is a TextGroupPart
          const textGroup = group as TextGroupPart;
          return (
            <TextBlock
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
            <div key={`${message.id}-tool-${index}`} className="mr-8">
              <ToolCallRenderer 
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
});

MessageRenderer.displayName = 'MessageRenderer';