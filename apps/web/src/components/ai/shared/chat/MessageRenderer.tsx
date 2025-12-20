import React, { useState, useEffect } from 'react';
import { ToolCallRenderer } from './tool-calls';

import { StreamingMarkdown } from './StreamingMarkdown';
import { MessageActionButtons } from './MessageActionButtons';
import { MessageEditor } from './MessageEditor';
import { DeleteMessageDialog } from './DeleteMessageDialog';
import { TodoListMessage } from './TodoListMessage';
import { useSocket } from '@/hooks/useSocket';
import { ErrorBoundary } from '@/components/ai/shared/ErrorBoundary';
import { patch, fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useGroupedParts } from './useGroupedParts';
import type { ConversationMessage, TextPart } from './message-types';
import { isTextGroupPart, isToolGroupPart } from './message-types';

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
  /** Whether this message is currently being streamed (for progressive markdown rendering) */
  isStreaming?: boolean;
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
            You
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
          <div className="text-gray-900 dark:text-gray-100 prose prose-sm dark:prose-invert max-w-full overflow-hidden prose-pre:bg-gray-100 dark:prose-pre:bg-gray-800">
            <div className="break-words overflow-wrap-anywhere">
              <StreamingMarkdown content={content} id={`${messageId}-text`} isStreaming={isStreaming} />
            </div>
          </div>
          {createdAt && (
            <div className="flex items-center justify-between mt-2">
              <div className="text-xs text-gray-500">
                {new Date(createdAt).toLocaleTimeString()}
                {editedAt && <span className="ml-2">(edited)</span>}
              </div>
              {onEdit && onDelete && !isEditing && (
                <MessageActionButtons
                  onEdit={onEdit}
                  onDelete={onDelete}
                  onRetry={onRetry}
                />
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
  message: ConversationMessage;
  onEdit?: (messageId: string, newContent: string) => Promise<void>;
  onDelete?: (messageId: string) => Promise<void>;
  onRetry?: (messageId: string) => void;
  onTaskUpdate?: (taskId: string, newStatus: 'pending' | 'in_progress' | 'completed' | 'blocked') => void;
  isLastAssistantMessage?: boolean;
  isLastUserMessage?: boolean;
  /** Whether this message is currently being streamed (for progressive markdown rendering) */
  isStreaming?: boolean;
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
      <div key={message.id} className="mb-2" style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 100px' }}>
        {groupedParts.map((group, index) => {
          if (isTextGroupPart(group)) {
            const isLastTextBlock = index === groupedParts.length - 1;

            return (
              <TextBlock
                key={`${message.id}-text-${index}`}
                parts={group.parts}
                role={message.role as 'user' | 'assistant' | 'system'}
                messageId={message.id}
                createdAt={isLastTextBlock ? createdAt : undefined}
                editedAt={isLastTextBlock ? editedAt : undefined}
                onEdit={onEdit ? () => setIsEditing(true) : undefined}
                onDelete={onDelete ? () => setShowDeleteDialog(true) : undefined}
                onRetry={canRetry ? handleRetry : undefined}
                isEditing={isEditing}
                onSaveEdit={handleSaveEdit}
                onCancelEdit={() => setIsEditing(false)}
                isStreaming={isStreaming}
              />
            );
          } else if (isToolGroupPart(group)) {
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
