import React, { useState, useEffect } from 'react';
import { CompactToolCallRenderer } from './tool-calls';
import { StreamingMarkdown } from './StreamingMarkdown';
import { MessageActionButtons } from './MessageActionButtons';
import { MessageEditor } from './MessageEditor';
import { DeleteMessageDialog } from './DeleteMessageDialog';
import { CompactTodoListMessage } from './CompactTodoListMessage';
import { useSocket } from '@/hooks/useSocket';
import { ErrorBoundary } from '@/components/ai/shared/ErrorBoundary';
import { patch, fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useGroupedParts } from './useGroupedParts';
import type { ConversationMessage, TextPart } from './message-types';
import { isTextGroupPart, isProcessedToolPart } from './message-types';
import styles from './CompactMessageRenderer.module.css';

interface CompactTextBlockProps {
  parts: TextPart[];
  role: 'user' | 'assistant' | 'system';
  messageId: string;
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
  messageId,
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
            You
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
            <StreamingMarkdown content={content} id={`${messageId}-text`} isStreaming={isStreaming} />
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
  const [isEditing, setIsEditing] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const canRetry = Boolean(onRetry) && (isLastAssistantMessage || isLastUserMessage);

  // ============================================
  // Todo List State & Socket (only for todo_list messages)
  // ============================================
  const [tasks, setTasks] = useState<Array<{
    id: string;
    title: string;
    status: 'pending' | 'in_progress' | 'completed' | 'blocked';
    priority: 'low' | 'medium' | 'high';
    position: number;
    updatedAt?: Date;
  }>>([]);
  const [taskList, setTaskList] = useState<{
    id: string;
    title: string;
    description?: string;
    status: string;
    createdAt?: Date;
    updatedAt?: Date;
  } | null>(null);
  const [isLoadingTasks, setIsLoadingTasks] = useState(false);

  // Socket connection (singleton pattern) - only used for todo_list messages
  const socket = useSocket();

  const loadTasksForMessage = async (messageId: string) => {
    setIsLoadingTasks(true);
    try {
      const response = await fetchWithAuth(`/api/ai/tasks/by-message/${messageId}`);
      if (response.ok) {
        const data = await response.json();
        setTasks(data.tasks || []);
        setTaskList(data.taskList);
      } else {
        console.error('Failed to load tasks for message:', messageId);
      }
    } catch (error) {
      console.error('Error loading tasks:', error);
    } finally {
      setIsLoadingTasks(false);
    }
  };

  // Load tasks for todo_list messages
  useEffect(() => {
    if (message.messageType === 'todo_list' && message.id) {
      loadTasksForMessage(message.id);
    }
  }, [message.messageType, message.id]);

  // Listen for real-time task updates
  useEffect(() => {
    if (!socket || message.messageType !== 'todo_list') return;

    const handleTaskUpdate = (payload: {
      taskId: string;
      data: { newStatus: 'pending' | 'in_progress' | 'completed' | 'blocked' };
    }) => {
      const taskInOurMessage = tasks.find(task => task.id === payload.taskId);
      if (taskInOurMessage) {
        setTasks(prevTasks =>
          prevTasks.map(task =>
            task.id === payload.taskId
              ? { ...task, status: payload.data.newStatus, updatedAt: new Date() }
              : task
          )
        );
      }
    };

    const handleTaskListUpdate = (payload: { taskListId: string }) => {
      if (taskList && payload.taskListId === taskList.id) {
        loadTasksForMessage(message.id);
      }
    };

    socket.on('task:task_updated', handleTaskUpdate);
    socket.on('task:task_list_created', handleTaskListUpdate);

    return () => {
      socket.off('task:task_updated', handleTaskUpdate);
      socket.off('task:task_list_created', handleTaskListUpdate);
    };
  }, [socket, message.messageType, message.id, tasks, taskList]);

  const handleTaskStatusUpdate = async (taskId: string, newStatus: 'pending' | 'in_progress' | 'completed' | 'blocked') => {
    try {
      await patch(`/api/ai/tasks/${taskId}/status`, { status: newStatus });
      setTasks(prevTasks =>
        prevTasks.map(task =>
          task.id === taskId ? { ...task, status: newStatus, updatedAt: new Date() } : task
        )
      );
      onTaskUpdate?.(taskId, newStatus);
    } catch (error) {
      console.error('Error updating task:', error);
    }
  };

  // ============================================
  // Standard Message Rendering
  // ============================================
  const groupedParts = useGroupedParts(message.parts);

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
  const hasToolCalls = groupedParts.some(g => isProcessedToolPart(g));

  return (
    <>
      <div key={message.id} className="mb-1 min-w-0 max-w-full" style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 80px' }}>
        {groupedParts.map((group, index) => {
          if (isTextGroupPart(group)) {
            const isLastTextBlock = index === groupedParts.length - 1;

            return (
              <CompactTextBlock
                key={`${message.id}-text-${index}`}
                parts={group.parts}
                role={message.role as 'user' | 'assistant' | 'system'}
                messageId={message.id}
                createdAt={isLastTextBlock ? createdAt : undefined}
                editedAt={isLastTextBlock ? editedAt : undefined}
                onEdit={onEdit ? () => setIsEditing(true) : undefined}
                onDelete={onDelete ? () => setShowDeleteDialog(true) : undefined}
                onRetry={canRetry ? handleRetry : undefined}
                onUndoFromHere={
                  message.role === 'assistant' && hasToolCalls && onUndoFromHere
                    ? () => onUndoFromHere(message.id)
                    : undefined
                }
                isEditing={isEditing}
                onSaveEdit={handleSaveEdit}
                onCancelEdit={() => setIsEditing(false)}
                isStreaming={isStreaming}
              />
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

CompactMessageRenderer.displayName = 'CompactMessageRenderer';
