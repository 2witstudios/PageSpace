import React, { useEffect, useState } from 'react';
import { UIMessage } from 'ai';
import { MessageRenderer } from './MessageRenderer';
import { TodoListMessage } from './TodoListMessage';
import { useSocket } from '@/hooks/useSocket';
import { ErrorBoundary } from './ErrorBoundary';
import { patch, fetchWithAuth } from '@/lib/auth-fetch';

// Extended message interface that includes database fields
interface ConversationMessage extends UIMessage {
  messageType?: 'standard' | 'todo_list';
  conversationId?: string;
  isActive?: boolean;
  agentRole?: string;
  editedAt?: Date;
  createdAt?: Date;
}

interface ConversationMessageRendererProps {
  message: ConversationMessage;
  onTaskUpdate?: (taskId: string, newStatus: 'pending' | 'in_progress' | 'completed' | 'blocked') => void;
}

/**
 * Renders different types of conversation messages including todo lists
 */
export const ConversationMessageRenderer: React.FC<ConversationMessageRendererProps> = React.memo(({ 
  message, 
  onTaskUpdate 
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
      // Check if this task update relates to our message
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
      // Check if this relates to our task list
      if (taskList && payload.taskListId === taskList.id) {
        // Reload tasks to get latest state
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
      // Fetch tasks associated with this message
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
      // Update task status via API
      await patch(`/api/ai/tasks/${taskId}/status`, { status: newStatus });

      // Update local state
      setTasks(prevTasks =>
        prevTasks.map(task =>
          task.id === taskId ? { ...task, status: newStatus, updatedAt: new Date() } : task
        )
      );

      // Call parent handler if provided
      onTaskUpdate?.(taskId, newStatus);
    } catch (error) {
      console.error('Error updating task:', error);
    }
  };

  // Render based on message type
  if (message.messageType === 'todo_list') {
    if (isLoading) {
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
          onTaskUpdate={handleTaskUpdate}
        />
      </ErrorBoundary>
    );
  }

  // Default to standard message rendering
  return <MessageRenderer message={message} />;
});

ConversationMessageRenderer.displayName = 'ConversationMessageRenderer';