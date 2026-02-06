import { DEFAULT_STATUS_CONFIG, type TaskStatusGroup } from '@/lib/task-status-config';
import { STATUS_ORDER } from '@/components/layout/middle-content/page-views/task-list/task-list-types';
import type { Task, StatusConfigsByTaskList } from './types';

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
/**
 * Aggregate statuses across task lists, deduped by slug. Falls back to
 * default statuses when no configs are present.
 */
export function aggregateStatuses(
  statusConfigsByTaskList: StatusConfigsByTaskList | undefined,
): Array<{ slug: string; label: string; color: string; position: number }> {
  if (!statusConfigsByTaskList || Object.keys(statusConfigsByTaskList).length === 0) {
    return STATUS_ORDER.map(slug => ({
      slug,
      label: DEFAULT_STATUS_CONFIG[slug]?.label || slug,
      color: DEFAULT_STATUS_CONFIG[slug]?.color || '',
      position: STATUS_ORDER.indexOf(slug),
    }));
  }
  const seen = new Map<string, { slug: string; label: string; color: string; position: number }>();
  for (const configs of Object.values(statusConfigsByTaskList)) {
    for (const c of configs) {
      if (!seen.has(c.slug)) {
        seen.set(c.slug, { slug: c.slug, label: c.name, color: c.color || '', position: c.position });
      }
    }
  }
  if (seen.size === 0) {
    return STATUS_ORDER.map(slug => ({
      slug,
      label: DEFAULT_STATUS_CONFIG[slug]?.label || slug,
      color: DEFAULT_STATUS_CONFIG[slug]?.color || '',
      position: STATUS_ORDER.indexOf(slug),
    }));
  }
  return [...seen.values()].sort((a, b) => a.position - b.position);
}

export function getAssigneeText(task: Task): string | null {
  if (task.assignees && task.assignees.length > 0) {
    return task.assignees.map(a => a.user?.name || a.agentPage?.title).filter(Boolean).join(', ') || null;
  }
  return task.assignee?.name || task.assigneeAgent?.title || null;
}
