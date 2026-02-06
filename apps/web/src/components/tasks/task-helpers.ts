import { DEFAULT_STATUS_CONFIG, type TaskStatusGroup } from '@/lib/task-status-config';
import type { Task } from './types';

/**
 * Resolve status display for a task. Prefers server-enriched metadata
 * (statusLabel/statusColor/statusGroup) when all three are present,
 * then falls back to DEFAULT_STATUS_CONFIG, then to a safe default.
 */
export function getStatusDisplay(task: Task): { label: string; color: string; group: TaskStatusGroup } {
  if (task.statusLabel && task.statusColor && task.statusGroup) {
    return { label: task.statusLabel, color: task.statusColor, group: task.statusGroup };
  }
  const defaultConfig = DEFAULT_STATUS_CONFIG[task.status];
  if (defaultConfig) return defaultConfig;
  return { label: task.status, color: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400', group: 'todo' };
}

/**
 * Get comma-separated display text for task assignees.
 * Prefers the multi-assignee array, falls back to legacy single assignee fields.
 */
export function getAssigneeText(task: Task): string | null {
  if (task.assignees && task.assignees.length > 0) {
    return task.assignees.map(a => a.user?.name || a.agentPage?.title).filter(Boolean).join(', ') || null;
  }
  return task.assignee?.name || task.assigneeAgent?.title || null;
}
