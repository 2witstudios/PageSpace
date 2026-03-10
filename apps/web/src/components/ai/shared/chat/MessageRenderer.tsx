import React, { useState } from 'react';
import { ToolCallRenderer } from './tool-calls';
import { StreamingMarkdown } from './StreamingMarkdown';
import { MessageActionButtons } from './MessageActionButtons';
import { MessageEditor } from './MessageEditor';
import { DeleteMessageDialog } from './DeleteMessageDialog';
import { TodoListMessage } from './TodoListMessage';
import { CompactTodoListMessage } from './CompactTodoListMessage';
import { ErrorBoundary } from '@/components/ai/shared/ErrorBoundary';
import { useTodoListState } from '@/lib/ai/shared/hooks/useTodoListState';
import { useGroupedParts } from './useGroupedParts';
import type { ConversationMessage, TextPart } from './message-types';
import { isTextGroupPart, isProcessedToolPart, isFileGroupPart } from './message-types';
import { ImageMessageContent } from './ImageMessageContent';
import styles from './CompactMessageRenderer.module.css';

interface TextBlockProps {
  parts: TextPart[];
  role: 'user' | 'assistant' | 'system';
  createdAt?: Date;
  editedAt?: Date | null;
  onEdit?: () => void;
  onDelete?: () => void;
  onRetry?: () => void;
  onUndoFromHere?: () => void;
  isEditing?: boolean;
  onSaveEdit?: (newContent: string) => Promise<void>;
  onCancelEdit?: () => void;
  isStreaming?: boolean;
  compact?: boolean;
}

const TextBlock: React.FC<TextBlockProps> = React.memo(({
  parts,
  role,
  createdAt,
  editedAt,
  onEdit,
  onDelete,
  onRetry,
  onUndoFromHere,
  isEditing,
  onSaveEdit,
  onCancelEdit,
  isStreaming = false,
  compact = false,
}) => {
  const content = parts.map(part => part.text).join('');
  if (!content.trim() && !isEditing) return null;

  const containerClass = compact
    ? `group relative text-xs mb-1 min-w-0 max-w-full ${role === 'user' ? 'p-2 rounded-md bg-primary/10 dark:bg-accent/20 ml-2' : ''}`
    : `group relative mb-1 ${role === 'user' ? 'p-3 rounded-lg bg-primary/10 dark:bg-accent/20 ml-2 sm:ml-8' : 'mr-2 sm:mr-8'}`;

  return (
    <div className={containerClass}>
      {role === 'user' && (
        <div className={`flex items-center ${compact ? 'mb-0.5' : 'mb-1'}`}>
          <div className={`${compact ? 'text-xs' : 'text-sm'} font-medium text-primary dark:text-primary`}>
            You
          </div>
        </div>
      )}

      {isEditing && onSaveEdit && onCancelEdit ? (
        <div className={compact ? 'text-xs' : undefined}>
          <MessageEditor
            initialContent={content}
            onSave={onSaveEdit}
            onCancel={onCancelEdit}
            placeholder={compact ? "Edit message..." : undefined}
          />
        </div>
      ) : (
        <>
          <div className={`text-gray-900 dark:text-gray-100 prose ${compact ? 'prose-xs' : 'prose-sm'} dark:prose-invert ${compact ? 'min-w-0 max-w-full break-words' : 'max-w-full'} prose-pre:bg-gray-100 dark:prose-pre:bg-gray-800 ${compact ? styles.compactProseContent : ''}`}>
            <div className="[overflow-wrap:break-word] [hyphens:auto] [text-wrap:pretty]">
              <StreamingMarkdown content={content} isStreaming={isStreaming} />
            </div>
          </div>
          <div className={`flex items-center justify-between ${compact ? 'mt-1' : 'mt-2'}`}>
            <div className={`${compact ? 'text-[10px]' : 'text-xs'} text-gray-500`}>
              {createdAt && (
                <>
                  {new Date(createdAt).toLocaleTimeString(compact ? undefined : [], compact ? { hour: '2-digit', minute: '2-digit' } : undefined)}
                  {editedAt && <span className={compact ? 'ml-1' : 'ml-2'}>(edited)</span>}
                </>
              )}
            </div>
            {onEdit && onDelete && !isEditing && (
              <MessageActionButtons
                onEdit={onEdit}
                onDelete={onDelete}
                onRetry={onRetry}
                onUndoFromHere={onUndoFromHere}
                compact={compact}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
});

TextBlock.displayName = 'TextBlock';

interface MessageRendererProps {
  message: ConversationMessage;
  onEdit?: (messageId: string, newContent: string) => Promise<void>;
  onDelete?: (messageId: string) => Promise<void>;
  onRetry?: (messageId: string) => void;
  onUndoFromHere?: (messageId: string) => void;
  onTaskUpdate?: (taskId: string, newStatus: 'pending' | 'in_progress' | 'completed' | 'blocked') => void;
  isLastAssistantMessage?: boolean;
  isLastUserMessage?: boolean;
  isStreaming?: boolean;
  compact?: boolean;
}

export const MessageRenderer: React.FC<MessageRendererProps> = React.memo(({
  message,
  onEdit,
  onDelete,
  onRetry,
  onUndoFromHere,
  onTaskUpdate,
  isLastAssistantMessage = false,
  isLastUserMessage = false,
  isStreaming = false,
  compact = false,
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const canRetry = Boolean(onRetry) && (isLastAssistantMessage || isLastUserMessage);

  const { tasks, taskList, isLoadingTasks, handleTaskStatusUpdate } = useTodoListState({
    messageId: message.id,
    messageType: message.messageType,
    onTaskUpdate,
  });

  const groupedParts = useGroupedParts(message.parts);
  const hasToolCalls = message.role === 'assistant' && groupedParts.some(isProcessedToolPart);

  const createdAt = message.createdAt;
  const editedAt = message.editedAt;

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

  // Render todo_list messages
  if (message.messageType === 'todo_list') {
    if (isLoadingTasks) {
      return (
        <div className={`${compact ? 'mb-3' : 'mb-4'} ${compact ? '' : 'mr-8'}`}>
          <div className={`bg-primary/${compact ? '10' : '5'} dark:bg-primary/${compact ? '20' : '10'} border border-primary/20 dark:border-primary/30 ${compact ? 'rounded-md p-2' : 'rounded-lg p-4'}`}>
            <div className="animate-pulse">
              <div className={`h-${compact ? '3' : '4'} bg-primary/${compact ? '30' : '20'} dark:bg-primary/${compact ? '50' : '30'} rounded ${compact ? 'w-2/3 mb-1' : 'w-1/3 mb-2'}`}></div>
              <div className={`h-${compact ? '1.5' : '2'} bg-primary/${compact ? '20' : '15'} dark:bg-primary/${compact ? '40' : '25'} rounded ${compact ? 'w-full mb-2' : 'w-full mb-3'}`}></div>
              <div className={`space-y-${compact ? '1' : '2'}`}>
                <div className={`h-${compact ? '6' : '8'} bg-white dark:bg-gray-800 rounded`}></div>
                <div className={`h-${compact ? '6' : '8'} bg-white dark:bg-gray-800 rounded`}></div>
                {compact ? null : <div className="h-8 bg-white dark:bg-gray-800 rounded"></div>}
              </div>
            </div>
          </div>
        </div>
      );
    }

    if (!taskList || tasks.length === 0) {
      return (
        <div className={`${compact ? 'mb-3' : 'mb-4'} ${compact ? '' : 'mr-8'}`}>
          <div className="bg-yellow-50 dark:bg-yellow-950/30 border border-yellow-200 dark:border-yellow-800 rounded-md p-4">
            <div className={`${compact ? 'text-xs' : ''} text-yellow-800 dark:text-yellow-200`}>
              No tasks found for this todo list.
            </div>
          </div>
        </div>
      );
    }

    const TodoListComponent = compact ? CompactTodoListMessage : TodoListMessage;

    return (
      <ErrorBoundary
        fallback={
          <div className={`${compact ? 'mb-3' : 'mb-4'}`}>
            <div className="bg-yellow-50 dark:bg-yellow-950/30 border border-yellow-200 dark:border-yellow-800 rounded-md p-4">
              <div className={`${compact ? 'text-xs' : ''} text-yellow-800 dark:text-yellow-200`}>
                Failed to load TODO list. Please refresh the page.
              </div>
            </div>
          </div>
        }
      >
        <TodoListComponent
          tasks={tasks}
          taskList={taskList}
          createdAt={message.createdAt}
          onTaskUpdate={handleTaskStatusUpdate}
        />
      </ErrorBoundary>
    );
  }

  // Render standard messages
  return (
    <>
      <div key={message.id} className={`${compact ? 'mb-1 min-w-0 max-w-full' : 'mb-2'}`}>
        {groupedParts.map((group, index) => {
          if (isTextGroupPart(group)) {
            const isLastTextBlock = index === groupedParts.length - 1;

            return (
              <TextBlock
                key={`${message.id}-text-${index}`}
                parts={group.parts}
                role={message.role as 'user' | 'assistant' | 'system'}
                createdAt={isLastTextBlock ? createdAt : undefined}
                editedAt={isLastTextBlock ? editedAt : undefined}
                onEdit={onEdit ? () => setIsEditing(true) : undefined}
                onDelete={onDelete ? () => setShowDeleteDialog(true) : undefined}
                onRetry={canRetry ? handleRetry : undefined}
                onUndoFromHere={hasToolCalls && onUndoFromHere ? () => onUndoFromHere(message.id) : undefined}
                isEditing={isEditing}
                onSaveEdit={handleSaveEdit}
                onCancelEdit={() => setIsEditing(false)}
                isStreaming={isStreaming}
                compact={compact}
              />
            );
          } else if (isFileGroupPart(group)) {
            return (
              <ImageMessageContent
                key={`${message.id}-file-${index}`}
                parts={group.parts}
                compact={compact}
              />
            );
          } else if (isProcessedToolPart(group)) {
            return (
              <div key={`${message.id}-tool-${index}`} className={compact ? 'mt-1' : 'mr-2 sm:mr-8'}>
                <ToolCallRenderer
                  part={{
                    type: group.type,
                    toolName: group.toolName,
                    toolCallId: group.toolCallId,
                    input: group.input,
                    output: group.output,
                    state: group.state,
                  }}
                  compact={compact}
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
});

MessageRenderer.displayName = 'MessageRenderer';
