import { useState, useEffect } from 'react';
import { useSocket } from '@/hooks/useSocket';
import { patch, fetchWithAuth } from '@/lib/auth/auth-fetch';

/**
 * Consolidated todo list state management hook.
 * Handles task loading, real-time socket updates, and status updates.
 * Extracts shared logic from MessageRenderer and CompactMessageRenderer.
 */
interface Task {
  id: string;
  title: string;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
  priority: 'low' | 'medium' | 'high';
  position: number;
  updatedAt?: Date;
}

interface TaskList {
  id: string;
  title: string;
  description?: string;
  status: string;
  createdAt?: Date;
  updatedAt?: Date;
}

interface UseTodoListStateOptions {
  messageId: string | undefined;
  messageType: string | undefined;
  onTaskUpdate?: (taskId: string, newStatus: 'pending' | 'in_progress' | 'completed' | 'blocked') => void;
}

interface UseTodoListStateReturn {
  tasks: Task[];
  taskList: TaskList | null;
  isLoadingTasks: boolean;
  handleTaskStatusUpdate: (taskId: string, newStatus: 'pending' | 'in_progress' | 'completed' | 'blocked') => Promise<void>;
}

export function useTodoListState({
  messageId,
  messageType,
  onTaskUpdate,
}: UseTodoListStateOptions): UseTodoListStateReturn {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [taskList, setTaskList] = useState<TaskList | null>(null);
  const [isLoadingTasks, setIsLoadingTasks] = useState(false);

  const socket = useSocket();

  const loadTasksForMessage = async (msgId: string) => {
    setIsLoadingTasks(true);
    try {
      const response = await fetchWithAuth(`/api/ai/tasks/by-message/${msgId}`);
      if (response.ok) {
        const data = await response.json();
        setTasks(data.tasks || []);
        setTaskList(data.taskList);
      } else {
        console.error('Failed to load tasks for message:', msgId);
      }
    } catch (error) {
      console.error('Error loading tasks:', error);
    } finally {
      setIsLoadingTasks(false);
    }
  };

  useEffect(() => {
    if (messageType === 'todo_list' && messageId) {
      loadTasksForMessage(messageId);
    }
  }, [messageType, messageId]);

  useEffect(() => {
    if (!socket || messageType !== 'todo_list') return;

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
      if (taskList && payload.taskListId === taskList.id && messageId) {
        loadTasksForMessage(messageId);
      }
    };

    socket.on('task:task_updated', handleTaskUpdate);
    socket.on('task:task_list_created', handleTaskListUpdate);

    return () => {
      socket.off('task:task_updated', handleTaskUpdate);
      socket.off('task:task_list_created', handleTaskListUpdate);
    };
  }, [socket, messageType, messageId, tasks, taskList]);

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

  return {
    tasks,
    taskList,
    isLoadingTasks,
    handleTaskStatusUpdate,
  };
}
