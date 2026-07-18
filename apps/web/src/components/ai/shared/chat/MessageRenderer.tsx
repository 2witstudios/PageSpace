import React from 'react';
import { cn } from '@/lib/utils';
import { RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ToolCallRenderer, ToolRunGroup } from './tool-calls';

import { StreamingMarkdown } from './StreamingMarkdown';
import { MessageActionButtons } from './MessageActionButtons';
import { MessageEditor } from './MessageEditor';
import { DeleteMessageDialog } from './DeleteMessageDialog';
import { TodoListMessage } from './TodoListMessage';
import { ErrorBoundary } from '@/components/ai/shared/ErrorBoundary';
import { useMessageRendererState } from './useMessageRendererState';
import type { ConversationMessage, TextPart } from './message-types';
import { isTextGroupPart, isProcessedToolPart, isFileGroupPart, isCommandExecutionPart, isToolRunGroupPart } from './message-types';
import { ImageMessageContent } from './ImageMessageContent';
import { CommandExecutionIndicator } from '@/components/messages/CommandExecutionIndicator';

interface TextBlockProps {
  parts: TextPart[];
  role: 'user' | 'assistant' | 'system';
  senderName?: string;
  createdAt?: Date;
  editedAt?: Date | null;
  onEdit?: () => void;
  onDelete?: () => void;
  onRetry?: () => void;
  onUndoFromHere?: () => void;
  isEditing?: boolean;
  onSaveEdit?: (newContent: string) => Promise<void>;
  onCancelEdit?: () => void;
  /** Whether this message is currently being streamed (for progressive markdown rendering) */
  isStreaming?: boolean;
}

/**
 * Renders a group of consecutive text parts as a single block
 */
const TextBlock: React.FC<TextBlockProps> = React.memo(({
  parts,
  role,
  senderName,
  createdAt,
  editedAt,
  onEdit,
  onDelete,
  onRetry,
  onUndoFromHere,
  isEditing,
  onSaveEdit,
  onCancelEdit,
  isStreaming = false
}) => {
  const content = parts.map(part => part.text).join('');

  if (!content.trim() && !isEditing) return null;

  return (
    <div
      className={`group relative mb-1 ${role === 'user'
        ? 'p-3 rounded-lg bg-primary/10 dark:bg-accent/20 ml-2 sm:ml-8'
        : 'mr-2 sm:mr-8'
        }`}
    >
      {role === 'user' && (
        <div className="flex items-center mb-1">
          <div className="text-sm font-medium text-primary dark:text-primary">
            {senderName}
          </div>
        </div>
      )}

      {isEditing && onSaveEdit && onCancelEdit ? (
        <MessageEditor
          initialContent={content}
          onSave={onSaveEdit}
          onCancel={onCancelEdit}
        />
      ) : (
        <>
          <div className="text-gray-900 dark:text-gray-100 prose prose-sm dark:prose-invert max-w-full prose-pre:bg-gray-100 dark:prose-pre:bg-gray-800">
            <div className="[overflow-wrap:break-word] [hyphens:auto] [text-wrap:pretty]">
              <StreamingMarkdown
                content={content}
                isStreaming={isStreaming}
                renderHtmlAsText={role === 'user'}
              />
            </div>
          </div>
          {/* Always show footer with buttons; timestamp only when createdAt exists */}
          <div className="flex items-center justify-between mt-2">
            <div className="text-xs text-gray-500">
              {createdAt && (
                <>
                  {new Date(createdAt).toLocaleTimeString()}
                  {editedAt && <span className="ml-2">(edited)</span>}
                </>
              )}
            </div>
            {onEdit && onDelete && !isEditing && (
              <MessageActionButtons
                onEdit={onEdit}
                onDelete={onDelete}
                onRetry={onRetry}
                onUndoFromHere={onUndoFromHere}
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
  /** Whether this message is currently being streamed (for progressive markdown rendering) */
  isStreaming?: boolean;
  /**
   * Find-in-conversation search highlight. Only the full renderer supports this —
   * the sidebar's compact renderer has no find-in-conversation feature, so
   * CompactMessageRenderer intentionally has no equivalent props.
   */
  isHighlighted?: boolean;
  isCurrentMatch?: boolean;
}

/**
 * Renders a UIMessage with parts in chronological order.
 * Supports both standard messages and todo_list messages with real-time socket updates.
 * Groups consecutive text parts together while preserving tool call positions.
 */
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
  isHighlighted = false,
  isCurrentMatch = false,
}) => {
  const {
    user,
    isEditing,
    setIsEditing,
    showDeleteDialog,
    setShowDeleteDialog,
    isDeleting,
    canRetry,
    tasks,
    taskList,
    isLoadingTasks,
    handleTaskStatusUpdate,
    groupedParts,
    getToolCallOpen,
    setToolCallOpen,
    hasToolCalls,
    isInterrupted,
    hasNonEmptyTextBlock,
    createdAt,
    editedAt,
    handleSaveEdit,
    handleDelete,
    handleRetry,
  } = useMessageRendererState({
    message,
    onEdit,
    onDelete,
    onRetry,
    onTaskUpdate,
    isLastAssistantMessage,
    isLastUserMessage,
  });

  // ============================================
  // Render todo_list messages
  // ============================================
  if (message.messageType === 'todo_list') {
    if (isLoadingTasks) {
      return (
        <div className="mb-4 mr-8">
          <div className="bg-primary/5 dark:bg-primary/10 border border-primary/20 dark:border-primary/30 rounded-lg p-4">
            <div className="animate-pulse">
              <div className="h-4 bg-primary/20 dark:bg-primary/30 rounded w-1/3 mb-2"></div>
              <div className="h-2 bg-primary/15 dark:bg-primary/25 rounded w-full mb-3"></div>
              <div className="space-y-2">
                <div className="h-8 bg-white dark:bg-gray-800 rounded"></div>
                <div className="h-8 bg-white dark:bg-gray-800 rounded"></div>
                <div className="h-8 bg-white dark:bg-gray-800 rounded"></div>
              </div>
            </div>
          </div>
        </div>
      );
    }

    if (!taskList || tasks.length === 0) {
      return (
        <div className="mb-4 mr-8">
          <div className="bg-yellow-50 dark:bg-yellow-950/30 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4">
            <div className="text-yellow-800 dark:text-yellow-200">
              No tasks found for this todo list.
            </div>
          </div>
        </div>
      );
    }

    return (
      <ErrorBoundary
        fallback={
          <div className="mb-4">
            <div className="bg-yellow-50 dark:bg-yellow-950/30 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4">
              <div className="text-yellow-800 dark:text-yellow-200">
                Failed to load TODO list. Please refresh the page.
              </div>
            </div>
          </div>
        }
      >
        <TodoListMessage
          tasks={tasks}
          taskList={taskList}
          createdAt={message.createdAt}
          onTaskUpdate={handleTaskStatusUpdate}
        />
      </ErrorBoundary>
    );
  }

  // ============================================
  // Render standard messages
  // ============================================
  return (
    <>
      <div key={message.id} data-testid="chat-message" data-role={message.role} data-message-id={message.id} className={cn("mb-2", isHighlighted && "find-highlight", isCurrentMatch && "find-highlight-current")}>
        {groupedParts.map((group, index) => {
          if (isTextGroupPart(group)) {
            const isLastTextBlock = index === groupedParts.length - 1;

            return (
              <TextBlock
                key={`${message.id}-text-${index}`}
                parts={group.parts}
                role={message.role as 'user' | 'assistant' | 'system'}
                senderName={message.userName ?? user?.name ?? 'Unknown'}
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
              />
            );
          } else if (isFileGroupPart(group)) {
            return (
              <ImageMessageContent
                key={`${message.id}-file-${index}`}
                parts={group.parts}
              />
            );
          } else if (isToolRunGroupPart(group)) {
            return (
              <div key={`${message.id}-toolrun-${group.runKey}`} className="mr-2 sm:mr-8">
                <ToolRunGroup
                  parts={group.parts}
                  runKey={group.runKey}
                  getToolCallOpen={getToolCallOpen}
                  setToolCallOpen={setToolCallOpen}
                />
              </div>
            );
          } else if (isProcessedToolPart(group)) {
            return (
              <div key={`${message.id}-tool-${index}`} className="mr-2 sm:mr-8">
                <ToolCallRenderer
                  part={{
                    type: group.type,
                    toolName: group.toolName,
                    toolCallId: group.toolCallId,
                    input: group.input,
                    output: group.output,
                    state: group.state,
                  }}
                  open={getToolCallOpen(group.toolCallId)}
                  onOpenChange={(next) => setToolCallOpen(group.toolCallId, next)}
                />
              </div>
            );
          } else if (isCommandExecutionPart(group)) {
            return (
              <div key={`${message.id}-command-${index}`} className="mr-2 sm:mr-8">
                <CommandExecutionIndicator data={group.data} />
              </div>
            );
          }
          return null;
        })}
        {isInterrupted && (
          <div className="mr-2 sm:mr-8 mt-1 flex items-center gap-2 text-xs" data-testid="interrupted-affordance">
            <span className="rounded bg-amber-100 dark:bg-amber-950/40 px-1.5 py-0.5 font-medium uppercase tracking-wide text-amber-700 dark:text-amber-400">
              Interrupted
            </span>
            {canRetry && (
              <span className="text-gray-500 dark:text-gray-400">Generation was cut short — retry to continue.</span>
            )}
            {/* An interrupted message with empty or tool-only content never renders a TextBlock
                (its footer is where the retry button normally lives) — this is the only retry
                control such a message gets. Gated on !hasNonEmptyTextBlock so a message that DID
                stream real text before dying doesn't show this button twice. */}
            {canRetry && !hasNonEmptyTextBlock && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleRetry}
                className="h-5 px-1"
                title="Retry this message"
                aria-label="Retry this message"
              >
                <RotateCw className="h-2.5 w-2.5" />
              </Button>
            )}
          </div>
        )}
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
