import React from 'react';
import { RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CompactToolCallRenderer, CompactToolRunGroup } from './tool-calls';
import { StreamingMarkdown } from './StreamingMarkdown';
import { MessageActionButtons } from './MessageActionButtons';
import { MessageEditor } from './MessageEditor';
import { DeleteMessageDialog } from './DeleteMessageDialog';
import { CompactTodoListMessage } from './CompactTodoListMessage';
import { ErrorBoundary } from '@/components/ai/shared/ErrorBoundary';
import { useMessageRendererState } from './useMessageRendererState';
import type { ConversationMessage, TextPart } from './message-types';
import { isTextGroupPart, isProcessedToolPart, isFileGroupPart, isCommandExecutionPart, isToolRunGroupPart } from './message-types';
import { CommandExecutionIndicator } from '@/components/messages/CommandExecutionIndicator';
import { ImageMessageContent } from './ImageMessageContent';
import styles from './CompactMessageRenderer.module.css';

interface CompactTextBlockProps {
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
 * Compact text block for sidebar - minimal margins and padding
 * Memoized to prevent unnecessary re-renders during streaming
 */
const CompactTextBlock: React.FC<CompactTextBlockProps> = React.memo(({
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
      className={`group relative text-xs mb-1 min-w-0 max-w-full ${role === 'user'
          ? 'p-2 rounded-md bg-primary/10 dark:bg-accent/20 ml-2'
          : ''
        }`}
    >
      {role === 'user' && (
        <div className="flex items-center mb-0.5">
          <div className="text-xs font-medium text-primary dark:text-primary">
            {senderName}
          </div>
        </div>
      )}

      {isEditing && onSaveEdit && onCancelEdit ? (
        <div className="text-xs">
          <MessageEditor
            initialContent={content}
            onSave={onSaveEdit}
            onCancel={onCancelEdit}
            placeholder="Edit message..."
          />
        </div>
      ) : (
        <>
          <div className={`text-gray-900 dark:text-gray-100 prose prose-xs dark:prose-invert min-w-0 max-w-full break-words ${styles.compactProseContent}`}>
            <StreamingMarkdown
              content={content}
              isStreaming={isStreaming}
              renderHtmlAsText={role === 'user'}
            />
          </div>
          {/* Always show footer with buttons; timestamp only when createdAt exists */}
          <div className="flex items-center justify-between mt-1">
            <div className="text-[10px] text-gray-500">
              {createdAt && (
                <>
                  {new Date(createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  {editedAt && <span className="ml-1">(edited)</span>}
                </>
              )}
            </div>
            {onEdit && onDelete && !isEditing && (
              <MessageActionButtons
                onEdit={onEdit}
                onDelete={onDelete}
                onRetry={onRetry}
                onUndoFromHere={onUndoFromHere}
                compact
              />
            )}
          </div>
        </>
      )}
    </div>
  );
});

CompactTextBlock.displayName = 'CompactTextBlock';

interface CompactMessageRendererProps {
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
}

/**
 * Compact message renderer for sidebar - optimized for narrow width.
 * Supports both standard messages and todo_list messages with real-time socket updates.
 *
 * No find-in-conversation highlighting here by design — that feature only exists in
 * the full MessageRenderer (main chat view); the sidebar has no find-in-conversation
 * UI, so there is no isHighlighted/isCurrentMatch prop to plumb through.
 */
export const CompactMessageRenderer: React.FC<CompactMessageRendererProps> = React.memo(({
  message,
  onEdit,
  onDelete,
  onRetry,
  onUndoFromHere,
  onTaskUpdate,
  isLastAssistantMessage = false,
  isLastUserMessage = false,
  isStreaming = false
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
        <div className="mb-3">
          <div className="bg-primary/10 dark:bg-primary/20 border border-primary/20 dark:border-primary/30 rounded-md p-2">
            <div className="animate-pulse">
              <div className="h-3 bg-primary/30 dark:bg-primary/50 rounded w-2/3 mb-1"></div>
              <div className="h-1.5 bg-primary/20 dark:bg-primary/40 rounded w-full mb-2"></div>
              <div className="space-y-1">
                <div className="h-6 bg-white dark:bg-gray-800 rounded"></div>
                <div className="h-6 bg-white dark:bg-gray-800 rounded"></div>
              </div>
            </div>
          </div>
        </div>
      );
    }

    if (!taskList || tasks.length === 0) {
      return (
        <div className="mb-3">
          <div className="bg-yellow-50 dark:bg-yellow-950/30 border border-yellow-200 dark:border-yellow-800 rounded-md p-2">
            <div className="text-xs text-yellow-700 dark:text-yellow-300">
              No tasks found for this todo list.
            </div>
          </div>
        </div>
      );
    }

    return (
      <ErrorBoundary
        fallback={
          <div className="mb-3">
            <div className="bg-yellow-50 dark:bg-yellow-950/30 border border-yellow-200 dark:border-yellow-800 rounded-md p-2">
              <div className="text-xs text-yellow-700 dark:text-yellow-300">
                Failed to load TODO list. Please refresh the page.
              </div>
            </div>
          </div>
        }
      >
        <CompactTodoListMessage
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
      <div key={message.id} data-testid="chat-message" data-role={message.role} data-message-id={message.id} className="mb-1 min-w-0 max-w-full">
        {groupedParts.map((group, index) => {
          if (isTextGroupPart(group)) {
            const isLastTextBlock = index === groupedParts.length - 1;

            return (
              <CompactTextBlock
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
                compact
              />
            );
          } else if (isToolRunGroupPart(group)) {
            return (
              <div key={`${message.id}-toolrun-${group.runKey}`} className="mt-1">
                <CompactToolRunGroup
                  parts={group.parts}
                  runKey={group.runKey}
                  getToolCallOpen={getToolCallOpen}
                  setToolCallOpen={setToolCallOpen}
                />
              </div>
            );
          } else if (isProcessedToolPart(group)) {
            return (
              <div key={`${message.id}-tool-${index}`} className="mt-1">
                <CompactToolCallRenderer
                  part={{
                    type: group.type,
                    toolName: group.toolName,
                    toolCallId: group.toolCallId,
                    input: group.input,
                    output: group.output,
                    state: group.state,
                  }}
                  expanded={getToolCallOpen(group.toolCallId)}
                  onExpandedChange={(next) => setToolCallOpen(group.toolCallId, next)}
                />
              </div>
            );
          } else if (isCommandExecutionPart(group)) {
            return (
              <div key={`${message.id}-command-${index}`} className="mt-1">
                <CommandExecutionIndicator data={group.data} />
              </div>
            );
          }
          return null;
        })}
        {isInterrupted && (
          <div className="mt-1 flex items-center gap-1.5 text-[10px]" data-testid="interrupted-affordance">
            <span className="rounded bg-amber-100 dark:bg-amber-950/40 px-1 py-0.5 font-medium uppercase tracking-wide text-amber-700 dark:text-amber-400">
              Interrupted
            </span>
            {canRetry && (
              <span className="text-gray-500 dark:text-gray-400">Cut short — retry to continue.</span>
            )}
            {/* CompactTextBlock is the only other place a retry button lives, and it only
                renders for non-empty content — this is the sole retry control for an
                empty/tool-only interrupted message. Gated on !hasNonEmptyTextBlock so a message
                that DID stream real text doesn't show the button twice. */}
            {canRetry && !hasNonEmptyTextBlock && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleRetry}
                className="h-4 px-0.5"
                title="Retry this message"
                aria-label="Retry this message"
              >
                <RotateCw className="h-2 w-2" />
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

CompactMessageRenderer.displayName = 'CompactMessageRenderer';
