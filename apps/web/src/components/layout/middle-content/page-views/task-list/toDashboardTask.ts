import { DEFAULT_STATUS_CONFIG } from '@/lib/task-status-config';
import type { TaskItem, TaskStatusConfig } from './task-list-types';
import type { Task } from '@/components/tasks/types';

/**
 * Adapt a page-view `TaskItem` into the dashboard-shaped `Task` that
 * `TaskCompactRow` and `TaskDetailSheet` consume.
 *
 * This exists because the two task surfaces are fed by different endpoints that
 * enrich differently. `/api/tasks` (the dashboard) resolves each task's status
 * against its list's custom configs and returns `statusLabel`/`statusColor`/
 * `statusGroup` on the row — see the enrichment block in
 * `apps/web/src/app/api/tasks/route.ts`. `/api/pages/[pageId]/tasks` does not,
 * and `TaskItem` carries no such fields.
 *
 * Both shared components read status through `getStatusDisplay`, which prefers
 * those three fields and otherwise falls back to `DEFAULT_STATUS_CONFIG`. So
 * without this adapter a task list with CUSTOM statuses would render its
 * statuses as raw slugs, and — because `isCompleted` is derived from the same
 * fallback (`group === 'done'`) — the row checkbox and strikethrough would be
 * wrong too. Resolving here keeps the shared components and every dashboard
 * call site untouched.
 *
 * Mirrors the server's resolution order exactly: custom config, then default
 * config, then the raw slug in the `todo` group.
 */
export function toDashboardTask(
  item: TaskItem,
  ctx: { driveId: string; taskListPageId: string; taskListPageTitle?: string },
  statusConfigs: TaskStatusConfig[],
): Task {
  const matchingConfig = statusConfigs.find((c) => c.slug === item.status);
  const defaultConfig = DEFAULT_STATUS_CONFIG[item.status];

  const statusGroup = matchingConfig?.group ?? defaultConfig?.group ?? 'todo';
  const statusLabel = matchingConfig?.name ?? defaultConfig?.label ?? item.status;
  const statusColor =
    matchingConfig?.color ||
    defaultConfig?.color ||
    'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400';

  return {
    id: item.id,
    userId: item.userId,
    assigneeId: item.assigneeId,
    assigneeAgentId: item.assigneeAgentId,
    pageId: item.pageId,
    title: item.title,
    status: item.status,
    priority: item.priority,
    position: item.position,
    dueDate: item.dueDate,
    completedAt: item.completedAt,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    assignee: item.assignee ?? null,
    // The page view's agent relation allows a null title; the dashboard shape
    // does not. An untitled agent reads as "Untitled agent" rather than being
    // dropped, so an assigned task never looks unassigned.
    assigneeAgent: item.assigneeAgent
      ? {
          id: item.assigneeAgent.id,
          title: item.assigneeAgent.title ?? 'Untitled agent',
          type: item.assigneeAgent.type,
        }
      : null,
    assignees: item.assignees,
    user: item.user ?? null,
    // `TaskItem.page` carries no title — the task's own title is the linked
    // page's title, so reuse it rather than inventing a placeholder.
    page: item.page
      ? { id: item.page.id, title: item.title, isTrashed: item.page.isTrashed }
      : null,
    driveId: ctx.driveId,
    taskListPageId: ctx.taskListPageId,
    taskListPageTitle: ctx.taskListPageTitle,
    activeTriggerCount: item.activeTriggerCount,
    statusGroup,
    statusLabel,
    statusColor,
  };
}
