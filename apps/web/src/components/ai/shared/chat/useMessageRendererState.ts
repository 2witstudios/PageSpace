import { useState, useEffect, useRef } from 'react';
import { useSocket } from '@/hooks/useSocket';
import { useAuth } from '@/hooks/useAuth';
import { patch, fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useGroupedParts } from './useGroupedParts';
import { useToolCallOpenState } from './useToolCallOpenState';
import type { ConversationMessage } from './message-types';
import { isTextGroupPart, isProcessedToolPart, isToolRunGroupPart } from './message-types';

type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'blocked';

interface RendererTask {
  id: string;
  title: string;
  status: TaskStatus;
  priority: 'low' | 'medium' | 'high';
  position: number;
  updatedAt?: Date;
}

interface RendererTaskList {
  id: string;
  title: string;
  description?: string;
  status: string;
  createdAt?: Date;
  updatedAt?: Date;
}

interface UseMessageRendererStateOptions {
  message: ConversationMessage;
  onEdit?: (messageId: string, newContent: string) => Promise<void>;
  onDelete?: (messageId: string) => Promise<void>;
  onRetry?: (messageId: string) => void;
  onTaskUpdate?: (taskId: string, newStatus: TaskStatus) => void;
  isLastAssistantMessage?: boolean;
  isLastUserMessage?: boolean;
}

/**
 * Shared state/logic for MessageRenderer and CompactMessageRenderer: todo-list
 * socket wiring, edit/delete/retry handlers, and the grouped-parts/tool-open-state
 * derivation. Each renderer owns only its own JSX/styling and choice of
 * full-vs-compact child components.
 */
export function useMessageRendererState({
  message,
  onEdit,
  onDelete,
  onRetry,
  onTaskUpdate,
  isLastAssistantMessage = false,
  isLastUserMessage = false,
}: UseMessageRendererStateOptions) {
  const { user } = useAuth();
  const [isEditing, setIsEditing] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const canRetry = Boolean(onRetry) && (isLastAssistantMessage || isLastUserMessage);

  // ============================================
  // Todo List State & Socket (only for todo_list messages)
  // ============================================
  const [tasks, setTasks] = useState<RendererTask[]>([]);
  const [taskList, setTaskList] = useState<RendererTaskList | null>(null);
  const [isLoadingTasks, setIsLoadingTasks] = useState(false);
  // Read inside the socket effect below without making taskList a dependency —
  // a fresh taskList reference on every reload would otherwise tear down and
  // re-register both listeners on every real-time task-list update.
  const taskListRef = useRef(taskList);
  taskListRef.current = taskList;

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
      data: { newStatus: TaskStatus };
    }) => {
      setTasks(prevTasks => {
        const taskInOurMessage = prevTasks.find(task => task.id === payload.taskId);
        if (!taskInOurMessage) return prevTasks;
        return prevTasks.map(task =>
          task.id === payload.taskId
            ? { ...task, status: payload.data.newStatus, updatedAt: new Date() }
            : task
        );
      });
    };

    const handleTaskListUpdate = (payload: { taskListId: string }) => {
      const currentTaskList = taskListRef.current;
      if (currentTaskList && payload.taskListId === currentTaskList.id) {
        loadTasksForMessage(message.id);
      }
    };

    socket.on('task:task_updated', handleTaskUpdate);
    socket.on('task:task_list_created', handleTaskListUpdate);

    return () => {
      socket.off('task:task_updated', handleTaskUpdate);
      socket.off('task:task_list_created', handleTaskListUpdate);
    };
  }, [socket, message.messageType, message.id]);

  const handleTaskStatusUpdate = async (taskId: string, newStatus: TaskStatus) => {
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
  const { getToolCallOpen, setToolCallOpen } = useToolCallOpenState();

  // Check if this message has tool calls (for showing undo button on assistant messages)
  const hasToolCalls = message.role === 'assistant' && groupedParts.some(g => isProcessedToolPart(g) || isToolRunGroupPart(g));

  const isInterrupted = message.role === 'assistant' && message.status === 'interrupted';
  // The renderer's own text block already renders its own retry button in its footer whenever it
  // has non-empty content — the message-level retry button that consumes this exists ONLY for the
  // case the text block can't cover (empty or tool-only content, where no text block ever
  // renders). Without this check, a normal interrupted message with real text would show two
  // retry buttons.
  const hasNonEmptyTextBlock = groupedParts.some(
    (g) => isTextGroupPart(g) && g.parts.map((p) => p.text).join('').trim() !== '',
  );

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

  return {
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
  };
}
