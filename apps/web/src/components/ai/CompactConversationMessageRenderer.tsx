import React, { useEffect, useState } from 'react';
import { UIMessage } from 'ai';
import { CompactMessageRenderer } from './CompactMessageRenderer';
import { CompactTodoListMessage } from './CompactTodoListMessage';
import { useSocket } from '@/hooks/useSocket';
import { ErrorBoundary } from './ErrorBoundary';
import { patch, fetchWithAuth } from '@/lib/auth-fetch';

// Extended message interface that includes database fields
interface ConversationMessage extends UIMessage {
  messageType?: 'standard' | 'todo_list';
  conversationId?: string;
  isActive?: boolean;
  editedAt?: Date;
  createdAt?: Date;
}

interface CompactConversationMessageRendererProps {
  message: ConversationMessage;
  onTaskUpdate?: (taskId: string, newStatus: 'pending' | 'in_progress' | 'completed' | 'blocked') => void;
  onEdit?: (messageId: string, newContent: string) => Promise<void>;
  onDelete?: (messageId: string) => Promise<void>;
  onRetry?: (messageId: string) => void;
  isLastAssistantMessage?: boolean;
  isLastUserMessage?: boolean;
}

/**
 * Compact version for sidebar - renders different types of conversation messages including todo lists
 */
export const CompactConversationMessageRenderer: React.FC<CompactConversationMessageRendererProps> = React.memo(({
  message,
  onTaskUpdate,
  onEdit,
  onDelete,
  onRetry,
  isLastAssistantMessage = false,
  isLastUserMessage = false
}) => {
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
  const [isLoading, setIsLoading] = useState(false);
  // Socket connection (managed by useSocket hook with singleton pattern)
  // Only used for TODO messages to receive real-time task updates
  const socket = useSocket();

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

  const loadTasksForMessage = async (messageId: string) => {
    setIsLoading(true);
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
      setIsLoading(false);
    }
  };

  const handleTaskUpdate = async (taskId: string, newStatus: 'pending' | 'in_progress' | 'completed' | 'blocked') => {
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

  // Render based on message type
  if (message.messageType === 'todo_list') {
    if (isLoading) {
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
          onTaskUpdate={handleTaskUpdate}
        />
      </ErrorBoundary>
    );
  }

  // Default to compact message rendering
  return (
    <CompactMessageRenderer
      message={message}
      onEdit={onEdit}
      onDelete={onDelete}
      onRetry={onRetry}
      isLastAssistantMessage={isLastAssistantMessage}
      isLastUserMessage={isLastUserMessage}
    />
  );
});

CompactConversationMessageRenderer.displayName = 'CompactConversationMessageRenderer';
