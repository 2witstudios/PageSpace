import React, { useMemo, useState } from 'react';
import { UIMessage } from 'ai';
import { ToolCallRenderer } from './ToolCallRenderer';
import { GroupedToolCallsRenderer } from './GroupedToolCallsRenderer';
import { MemoizedMarkdown } from './MemoizedMarkdown';
import { MessageActionButtons } from './MessageActionButtons';
import { MessageEditor } from './MessageEditor';
import { DeleteMessageDialog } from './DeleteMessageDialog';

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

interface ToolCallsGroupPart {
  type: 'tool-calls-group';
  tools: ToolGroupPart[];
}

type GroupedPart = TextGroupPart | ToolGroupPart | ToolCallsGroupPart;

interface TextBlockProps {
  parts: TextPart[];
  role: 'user' | 'assistant' | 'system';
  messageId: string;
  createdAt?: Date;
  editedAt?: Date | null;
  onEdit?: () => void;
  onDelete?: () => void;
  onRetry?: () => void;
  isEditing?: boolean;
  onSaveEdit?: (newContent: string) => Promise<void>;
  onCancelEdit?: () => void;
}

/**
 * Renders a group of consecutive text parts as a single block
 */
const TextBlock: React.FC<TextBlockProps> = React.memo(({
  parts,
  role,
  messageId,
  createdAt,
  editedAt,
  onEdit,
  onDelete,
  onRetry,
  isEditing,
  onSaveEdit,
  onCancelEdit
}) => {
  const content = parts.map(part => part.text).join('');

  if (!content.trim() && !isEditing) return null;

  return (
    <div
      className={`group relative p-3 rounded-lg mb-2 ${
        role === 'user'
          ? 'bg-primary/10 dark:bg-accent/20 ml-2 sm:ml-8'
          : 'bg-gray-50 dark:bg-gray-800/50 mr-2 sm:mr-8'
      }`}
    >
      <div className="flex items-center justify-between mb-1">
        <div className={`text-sm font-medium ${
          role === 'user' ? 'text-primary dark:text-primary' : 'text-gray-700 dark:text-gray-300'
        }`}>
          {role === 'user' ? 'You' : 'Assistant'}
          {editedAt && !isEditing && (
            <span className="ml-2 text-xs text-muted-foreground">(edited)</span>
          )}
        </div>
        {onEdit && onDelete && !isEditing && (
          <MessageActionButtons
            onEdit={onEdit}
            onDelete={onDelete}
            onRetry={onRetry}
          />
        )}
      </div>

      {isEditing && onSaveEdit && onCancelEdit ? (
        <MessageEditor
          initialContent={content}
          onSave={onSaveEdit}
          onCancel={onCancelEdit}
        />
      ) : (
        <>
          <div className="text-gray-900 dark:text-gray-100 prose prose-sm dark:prose-invert max-w-full overflow-hidden prose-pre:bg-gray-100 dark:prose-pre:bg-gray-800">
            <div className="break-words overflow-wrap-anywhere">
              <MemoizedMarkdown content={content} id={`${messageId}-text`} />
            </div>
          </div>
          {createdAt && (
            <div className="text-xs text-gray-500 mt-2">
              {new Date(createdAt).toLocaleTimeString()}
              {editedAt && (
                <span className="ml-2">
                  (edited {new Date(editedAt).toLocaleTimeString()})
                </span>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
});

TextBlock.displayName = 'TextBlock';

interface MessageRendererProps {
  message: UIMessage;
  onEdit?: (messageId: string, newContent: string) => Promise<void>;
  onDelete?: (messageId: string) => Promise<void>;
  onRetry?: (messageId: string) => void;
  isLastAssistantMessage?: boolean;
  isLastUserMessage?: boolean;
}

/**
 * Renders a UIMessage with parts in chronological order
 * Groups consecutive text parts together while preserving tool call positions
 */
export const MessageRenderer: React.FC<MessageRendererProps> = ({
  message,
  onEdit,
  onDelete,
  onRetry,
  isLastAssistantMessage = false,
  isLastUserMessage = false
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const canRetry = Boolean(onRetry) && (isLastAssistantMessage || isLastUserMessage);
  const groupedParts = useMemo(() => {
    if (!message.parts || message.parts.length === 0) {
      return [];
    }

    const groups: GroupedPart[] = [];
    let currentTextGroup: TextPart[] = [];
    let currentToolGroup: ToolGroupPart[] = [];

    message.parts.forEach((part) => {
      // Skip step-start and reasoning parts - they shouldn't break up tool groups
      if (part.type === 'step-start' || part.type === 'reasoning') {
        return;
      }

      if (part.type === 'text') {
        // If we have accumulated tool parts, add them as a group
        if (currentToolGroup.length > 0) {
          // Always create a group for tool calls, even single ones
          groups.push({
            type: 'tool-calls-group',
            tools: currentToolGroup
          });
          currentToolGroup = [];
        }

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

        // Check if tool type changed - flush current group if different type
        if (currentToolGroup.length > 0 && currentToolGroup[0].type !== part.type) {
          groups.push({
            type: 'tool-calls-group',
            tools: currentToolGroup
          });
          currentToolGroup = [];
        }

        // Add the tool part to current group
        currentToolGroup.push({
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

    // Add any remaining tool parts
    if (currentToolGroup.length > 0) {
      // Always create a group for tool calls, even single ones
      groups.push({
        type: 'tool-calls-group',
        tools: currentToolGroup
      });
    }

    return groups;
  }, [message.parts]); // Remove message.id as it's not needed for memoization

  const createdAt = (message as { createdAt?: Date }).createdAt;
  const editedAt = (message as { editedAt?: Date }).editedAt;

  const handleSaveEdit = async (newContent: string) => {
    if (onEdit) {
      await onEdit(message.id, newContent);
      setIsEditing(false);
    }
  };

  const handleDelete = async () => {
    if (onDelete) {
      setIsDeleting(true);
      try {
        await onDelete(message.id);
        setShowDeleteDialog(false);
      } catch (error) {
        console.error('Failed to delete message:', error);
      } finally {
        setIsDeleting(false);
      }
    }
  };

  const handleRetry = () => {
    if (onRetry && canRetry) {
      onRetry(message.id);
    }
  };

  return (
    <>
      <div key={message.id} className="mb-4">
        {groupedParts.map((group, index) => {
          if (group.type === 'text-group') {
            // Type narrowing: we know this is a TextGroupPart
            const textGroup = group as TextGroupPart;
            const isLastTextBlock = index === groupedParts.length - 1;

            return (
              <TextBlock
                key={`${message.id}-text-${index}`}
                parts={textGroup.parts}
                role={message.role as 'user' | 'assistant' | 'system'}
                messageId={message.id}
                createdAt={isLastTextBlock ? createdAt : undefined} // Only show timestamp on last part
                editedAt={isLastTextBlock ? editedAt : undefined}
                onEdit={onEdit ? () => setIsEditing(true) : undefined}
                onDelete={onDelete ? () => setShowDeleteDialog(true) : undefined}
                onRetry={canRetry ? handleRetry : undefined}
                isEditing={isEditing}
                onSaveEdit={handleSaveEdit}
                onCancelEdit={() => setIsEditing(false)}
              />
            );
          } else if (group.type === 'tool-calls-group') {
            // Type narrowing: we know this is a ToolCallsGroupPart
            const toolCallsGroup = group as ToolCallsGroupPart;
            return (
              <div key={`${message.id}-toolgroup-${index}`} className="mr-2 sm:mr-8">
                <GroupedToolCallsRenderer
                  toolCalls={toolCallsGroup.tools.map(tool => ({
                    type: tool.type,
                    toolName: tool.toolName,
                    toolCallId: tool.toolCallId,
                    input: tool.input,
                    output: tool.output,
                    state: tool.state,
                  }))}
                />
              </div>
            );
          } else if (group.type.startsWith('tool-')) {
            // Type narrowing: we know this is a ToolGroupPart
            const toolGroup = group as ToolGroupPart;
            return (
              <div key={`${message.id}-tool-${index}`} className="mr-2 sm:mr-8">
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

      {onDelete && (
        <DeleteMessageDialog
          open={showDeleteDialog}
          onOpenChange={setShowDeleteDialog}
          onConfirm={handleDelete}
          isDeleting={isDeleting}
        />
      )}
    </>
  );
};
