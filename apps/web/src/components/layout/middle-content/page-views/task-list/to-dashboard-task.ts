import type { TaskStatusGroup } from '@/lib/task-status-config';
import { buildStatusConfig } from './task-list-types';
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
 * It resolves against THIS list's vocabulary rather than the server's merged
 * order (custom config, then defaults, then the slug). The server serves a
 * dashboard spanning many lists, where falling back to the shared defaults is
 * the only sensible guess; here the list's own statuses are authoritative, and
 * matching them is what keeps the row, the table and the filter agreeing about
 * which tasks are done.
 */
export function toDashboardTask(
  item: TaskItem,
  ctx: { driveId: string; taskListPageId: string; taskListPageTitle?: string },
  statusConfigs: TaskStatusConfig[],
): Task {
  // buildStatusConfig is the same vocabulary the table, the kanban and the
  // filter read: the list's own statuses when it defines any, and the shared
  // defaults only when it does not. Resolving through it means done-ness here
  // agrees with isCompletedStatus by construction — a slug the list does not
  // define (a task still holding "completed" on a shipped/wip list) is an
  // unknown status to every surface alike, rather than a ticked, struck-through
  // row that the filter still lists as active and that does nothing when
  // unticked.
  const config = buildStatusConfig(statusConfigs)[item.status];

  const statusGroup: TaskStatusGroup = config?.group ?? 'todo';
  const statusLabel = config?.label || item.status;
  const statusColor =
    config?.color ||
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
