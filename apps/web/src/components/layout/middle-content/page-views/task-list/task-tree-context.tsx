'use client';

import { createContext, useContext } from 'react';
import type { TaskItem, TaskStatusConfig } from './task-list-types';
import type { TaskWriteMachinery } from '@/lib/tasks/task-write-machinery';
import type { TaskNodePath } from './task-tree-core';

/**
 * Everything a task row needs that is the same at every depth.
 *
 * Rows are rendered by component recursion (TaskRowGroup), so prop-drilling
 * this through an arbitrary number of levels would be noise. What stays on
 * props is what genuinely varies per node: the task, its depth, the list it
 * belongs to, its path, and the callbacks that talk to its own cache.
 */
export interface TaskTreeContextValue {
  canEdit: boolean;
  driveId: string;
  /**
   * The view-wide write machinery (self-write log + deferred revalidation).
   *
   * Carried here rather than through a second provider so there is exactly one
   * place a row can get it from. Every expanded node binds it to its OWN cache
   * via useTaskWriter — the machinery is shared, the cache is not.
   */
  writeMachinery: TaskWriteMachinery;
  /**
   * The ROOT list's status vocabulary. Nested rows render this rather than
   * their own list's, so a tree shows one consistent set of statuses — see
   * resolveNodeStatusConfigs for what happens when a legacy sub-list cannot
   * accept it.
   */
  rootStatusConfigs: TaskStatusConfig[];
  onNavigate: (task: TaskItem) => void;
  /** Puts a row into title-edit mode; shared by every depth. */
  onStartEdit: (task: TaskItem) => void;
  openTriggerDialog: (task: TaskItem, listPageId: string) => void;

  expandedPaths: ReadonlySet<TaskNodePath>;
  toggleExpanded: (path: TaskNodePath) => void;

  editingTaskId: string | null;
  editingTitle: string;
  onEditingTitleChange: (title: string) => void;
  onCancelEdit: () => void;
}

const TaskTreeContext = createContext<TaskTreeContextValue | null>(null);

export const TaskTreeProvider = TaskTreeContext.Provider;

export function useTaskTree(): TaskTreeContextValue {
  const value = useContext(TaskTreeContext);
  if (!value) throw new Error('Task tree components must be rendered inside a TaskTreeProvider');
  return value;
}
