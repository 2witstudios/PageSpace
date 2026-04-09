'use client';

import { useState, useCallback, useRef } from 'react';
import { mutate } from 'swr';
import { toast } from 'sonner';
import { patch, del, post } from '@/lib/auth/auth-fetch';
import type { Task, StatusConfigsByTaskList } from './types';
import type { TaskStatusConfig, TaskPriority } from '@/components/layout/middle-content/page-views/task-list/task-list-types';
import { buildStatusConfig } from '@/components/layout/middle-content/page-views/task-list/task-list-types';
import { DEFAULT_STATUS_CONFIG } from '@/lib/task-status-config';

export interface UseTaskMutationsOptions {
  onPageMutate?: (pageId: string) => void;
  onSuccess?: () => void;
  onError?: (error: Error) => void;
}

export interface TaskMutations {
  handleStatusChange: (task: Task, newStatus: string) => Promise<void>;
  handlePriorityChange: (task: Task, newPriority: string) => Promise<void>;
  handleToggleComplete: (task: Task) => Promise<void>;
  handleMultiAssigneeChange: (task: Task, assigneeIds: { type: 'user' | 'agent'; id: string }[]) => Promise<void>;
  handleDueDateChange: (task: Task, dueDate: Date | null) => Promise<void>;
  handleSaveTitle: (task: Task, title: string) => Promise<void>;
  handleDelete: (task: Task) => Promise<void>;
  handleCreate: (taskListPageId: string, data: { title: string; status?: string; priority?: TaskPriority; assigneeIds?: { type: 'user' | 'agent'; id: string }[]; dueDate?: string }) => Promise<void>;
}

export function useTaskMutations(
  setTasks: React.Dispatch<React.SetStateAction<Task[]>>,
  statusConfigsByTaskList: StatusConfigsByTaskList,
  options: UseTaskMutationsOptions = {}
): TaskMutations {
  const { onPageMutate, onSuccess, onError } = options;

  const getConfigsForTask = useCallback((task: Task): TaskStatusConfig[] => {
    return statusConfigsByTaskList[task.taskListId] || [];
  }, [statusConfigsByTaskList]);

  const handleError = useCallback((error: Error, message: string) => {
    toast.error(message);
    onError?.(error);
  }, [onError]);

  const handleStatusChange = useCallback(async (task: Task, newStatus: string) => {
    if (!task.taskListPageId) return;

    const configs = getConfigsForTask(task);
    const configMap = buildStatusConfig(configs);
    const matched = configMap[newStatus];
    const fallback = DEFAULT_STATUS_CONFIG[newStatus];

    setTasks(prev => prev.map(t =>
      t.id === task.id
        ? {
            ...t,
            status: newStatus,
            statusGroup: matched?.group ?? fallback?.group ?? t.statusGroup,
            statusLabel: matched?.label ?? fallback?.label ?? t.statusLabel,
            statusColor: matched?.color ?? fallback?.color ?? t.statusColor,
          }
        : t
    ));

    try {
      await patch(`/api/pages/${task.taskListPageId}/tasks/${task.id}`, { status: newStatus });
      onPageMutate?.(task.taskListPageId);
      onSuccess?.();
    } catch (err) {
      handleError(err as Error, 'Failed to update status');
      setTasks(prev => prev.map(t => t.id === task.id ? task : t));
    }
  }, [getConfigsForTask, setTasks, onPageMutate, onSuccess, handleError]);

  const handlePriorityChange = useCallback(async (task: Task, newPriority: string) => {
    if (!task.taskListPageId) return;

    setTasks(prev => prev.map(t =>
      t.id === task.id ? { ...t, priority: newPriority as TaskPriority } : t
    ));

    try {
      await patch(`/api/pages/${task.taskListPageId}/tasks/${task.id}`, { priority: newPriority });
      onPageMutate?.(task.taskListPageId);
      onSuccess?.();
    } catch (err) {
      handleError(err as Error, 'Failed to update priority');
      setTasks(prev => prev.map(t => t.id === task.id ? task : t));
    }
  }, [setTasks, onPageMutate, onSuccess, handleError]);

  const handleToggleComplete = useCallback(async (task: Task) => {
    const configs = getConfigsForTask(task);
    const sorted = [...configs].sort((a, b) => a.position - b.position);
    const isDone = configs.find(c => c.slug === task.status)?.group === 'done';

    let targetStatus: string;
    if (isDone) {
      const firstTodo = sorted.find(c => c.group === 'todo');
      targetStatus = firstTodo?.slug || 'pending';
    } else {
      const firstDone = sorted.find(c => c.group === 'done');
      targetStatus = firstDone?.slug || 'completed';
    }

    await handleStatusChange(task, targetStatus);
  }, [getConfigsForTask, handleStatusChange]);

  const handleMultiAssigneeChange = useCallback(async (task: Task, assigneeIds: { type: 'user' | 'agent'; id: string }[]) => {
    if (!task.taskListPageId) return;

    try {
      await patch(`/api/pages/${task.taskListPageId}/tasks/${task.id}`, { assigneeIds });
      onPageMutate?.(task.taskListPageId);
      onSuccess?.();
      // Refetch to get updated assignee data - assignees have relation data
      mutate(`/api/pages/${task.taskListPageId}/tasks`);
    } catch (err) {
      handleError(err as Error, 'Failed to update assignees');
    }
  }, [onPageMutate, onSuccess, handleError]);

  const handleDueDateChange = useCallback(async (task: Task, dueDate: Date | null) => {
    if (!task.taskListPageId) return;

    setTasks(prev => prev.map(t =>
      t.id === task.id ? { ...t, dueDate: dueDate?.toISOString() || null } : t
    ));

    try {
      await patch(`/api/pages/${task.taskListPageId}/tasks/${task.id}`, {
        dueDate: dueDate?.toISOString() || null,
      });
      onPageMutate?.(task.taskListPageId);
      onSuccess?.();
    } catch (err) {
      handleError(err as Error, 'Failed to update due date');
      setTasks(prev => prev.map(t => t.id === task.id ? task : t));
    }
  }, [setTasks, onPageMutate, onSuccess, handleError]);

  const handleSaveTitle = useCallback(async (task: Task, title: string) => {
    if (!task.taskListPageId || !title.trim()) return;

    const trimmedTitle = title.trim();
    setTasks(prev => prev.map(t =>
      t.id === task.id ? { ...t, title: trimmedTitle } : t
    ));

    try {
      await patch(`/api/pages/${task.taskListPageId}/tasks/${task.id}`, { title: trimmedTitle });
      onPageMutate?.(task.taskListPageId);
      onSuccess?.();
    } catch (err) {
      handleError(err as Error, 'Failed to update task title');
      setTasks(prev => prev.map(t => t.id === task.id ? task : t));
    }
  }, [setTasks, onPageMutate, onSuccess, handleError]);

  const handleDelete = useCallback(async (task: Task) => {
    if (!task.taskListPageId) return;

    setTasks(prev => prev.filter(t => t.id !== task.id));

    try {
      await del(`/api/pages/${task.taskListPageId}/tasks/${task.id}`);
      toast.success('Task deleted');
      onPageMutate?.(task.taskListPageId);
      onSuccess?.();
    } catch (err) {
      handleError(err as Error, 'Failed to delete task');
      setTasks(prev => [...prev, task]);
    }
  }, [setTasks, onPageMutate, onSuccess, handleError]);

  const handleCreate = useCallback(async (
    taskListPageId: string,
    data: { title: string; status?: string; priority?: TaskPriority; assigneeIds?: { type: 'user' | 'agent'; id: string }[]; dueDate?: string }
  ) => {
    if (!data.title.trim()) return;

    try {
      await post(`/api/pages/${taskListPageId}/tasks`, data);
      mutate(`/api/pages/${taskListPageId}/tasks`);
      onSuccess?.();
    } catch (err) {
      handleError(err as Error, 'Failed to create task');
    }
  }, [onSuccess, handleError]);

  return {
    handleStatusChange,
    handlePriorityChange,
    handleToggleComplete,
    handleMultiAssigneeChange,
    handleDueDateChange,
    handleSaveTitle,
    handleDelete,
    handleCreate,
  };
}

export interface EditingState {
  editingTaskId: string | null;
  editingTitle: string;
}

export function useEditingState() {
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const cancelTriggeredRef = useRef(false);

  const startEdit = useCallback((task: Task) => {
    setEditingTaskId(task.id);
    setEditingTitle(task.title);
    cancelTriggeredRef.current = false;
  }, []);

  const cancelEdit = useCallback(() => {
    cancelTriggeredRef.current = true;
    setEditingTaskId(null);
  }, []);

  const isEditing = useCallback((taskId: string) => editingTaskId === taskId, [editingTaskId]);

  return {
    editingTaskId,
    editingTitle,
    setEditingTitle,
    startEdit,
    cancelEdit,
    isEditing,
    cancelTriggeredRef,
  };
}

export interface FilterState {
  status?: string;
  priority?: TaskPriority;
  dueDateFilter?: 'all' | 'overdue' | 'today' | 'this_week' | 'upcoming';
  assigneeFilter?: 'mine' | 'all';
  driveId?: string;
  search?: string;
}

export function useFilterState(initialState?: FilterState) {
  const [filters, setFilters] = useState<FilterState>(initialState || { assigneeFilter: 'mine' });

  const updateFilter = useCallback(<K extends keyof FilterState>(key: K, value: FilterState[K]) => {
    setFilters(prev => ({ ...prev, [key]: value }));
  }, []);

  const updateFilters = useCallback((updates: Partial<FilterState>) => {
    setFilters(prev => ({ ...prev, ...updates }));
  }, []);

  const clearFilters = useCallback(() => {
    setFilters({ assigneeFilter: 'mine' });
  }, []);

  const hasActiveFilters = useCallback((context: 'user' | 'drive'): boolean => {
    return Boolean(
      filters.search ||
      filters.status ||
      filters.priority ||
      (filters.dueDateFilter && filters.dueDateFilter !== 'all') ||
      (context === 'user' && filters.driveId) ||
      filters.assigneeFilter === 'all'
    );
  }, [filters]);

  const activeFilterCount = useCallback((context: 'user' | 'drive'): number => {
    return [
      filters.search,
      filters.status,
      filters.priority,
      filters.dueDateFilter && filters.dueDateFilter !== 'all',
      context === 'user' && filters.driveId,
      filters.assigneeFilter === 'all',
    ].filter(Boolean).length;
  }, [filters]);

  return {
    filters,
    setFilters,
    updateFilter,
    updateFilters,
    clearFilters,
    hasActiveFilters,
    activeFilterCount,
  };
}

export function useSearchDebounce(
  initialValue: string,
  onDebounce: (value: string) => void,
  delay: number = 300
) {
  const [value, setValue] = useState(initialValue);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  const handleChange = useCallback((newValue: string) => {
    setValue(newValue);
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    timeoutRef.current = setTimeout(() => {
      onDebounce(newValue);
    }, delay);
  }, [onDebounce, delay]);

  const clearValue = useCallback(() => {
    setValue('');
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    onDebounce('');
  }, [onDebounce]);

  return { value, handleChange, clearValue, setValue };
}
